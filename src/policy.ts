import type { Config } from "./config";
import type { Account, Book, Decision, ExitQuote, Fee, Quote, Side, Signal, Snapshot, Trade } from "./types";

export function feePerShare(price: number, fee: Fee): number {
  return fee.rate * (price * (1 - price)) ** fee.exponent;
}

/** Walk visible asks within the allowed slippage, paying fee as a cash equivalent.
 * No invented liquidity: insufficient depth rejects the full simulated order. */
export function quoteBuy(book: Book, side: Side, budget: number, fee: Fee, slippage: number): Quote | null {
  const best = book.asks[0];
  if (!best) return null;
  let remaining = budget, shares = 0, notional = 0, fees = 0;
  for (const level of book.asks) {
    if (level.price > best.price + slippage + 1e-10) break;
    const perShare = feePerShare(level.price, fee);
    const quantity = Math.min(level.size, remaining / (level.price + perShare));
    shares += quantity;
    notional += quantity * level.price;
    fees += quantity * perShare;
    remaining -= quantity * (level.price + perShare);
    if (remaining < 1e-8) break;
  }
  if (remaining > 1e-6 || shares < book.minOrderSize || shares <= 0) return null;
  return { side, shares, notional, fee: fees, total: notional + fees, averagePrice: notional / shares, edge: 0 };
}

/** Walk visible bids down to bestBid - slippage for the full position; fees reduce proceeds.
 * Insufficient depth rejects the whole sell rather than inventing liquidity. */
export function quoteSell(book: Book, shares: number, fee: Fee, slippage: number): Omit<ExitQuote, "tradeId" | "side" | "score"> | null {
  const best = book.bids[0];
  if (!best) return null;
  let remaining = shares, notional = 0, fees = 0;
  for (const level of book.bids) {
    if (level.price < best.price - slippage - 1e-10) break;
    const quantity = Math.min(level.size, remaining);
    notional += quantity * level.price;
    fees += quantity * feePerShare(level.price, fee);
    remaining -= quantity;
    if (remaining < 1e-9) break;
  }
  if (remaining > 1e-9) return null;
  return { shares, notional, fee: fees, proceeds: notional - fees, averagePrice: notional / shares, bestBid: best.price };
}

/** Holding rule: sell once the market bids above Jev's probability for the held side; otherwise hold to settlement. */
export function evaluateExit(s: Snapshot, d: Decision, trade: Trade, c: Config, now: number): Signal {
  const hold = (reason: string): Signal => ({ action: "wait", reason });
  const side = trade.side, label = side.toUpperCase(), score = d.scores[side];
  if (now - d.at > c.maxDataAgeMs || d.at > now + 2000) return hold(`持有 ${label}：模型结果已过期，暂不卖出`);
  if (!s.market.fee) return hold(`持有 ${label}：缺少可靠的手续费参数，暂不卖出`);
  const bid = s.books[side].bids[0];
  if (!bid || bid.price <= score) return hold(`持有 ${label}：买一 ${bid ? (bid.price * 100).toFixed(1) : "—"}¢ 未高于 Jev ${(score * 100).toFixed(1)}¢，继续持有`);
  const q = quoteSell(s.books[side], trade.shares, s.market.fee, c.slippageBuffer);
  if (!q) return hold(`持有 ${label}：买一高于 Jev，但买盘深度不足以整笔卖出`);
  return { action: "sell", exit: { ...q, tradeId: trade.id, side, score },
    reason: `卖出 ${label}：买一 ${(bid.price * 100).toFixed(1)}¢ 高于 Jev ${(score * 100).toFixed(1)}¢，卖出均价 ${(q.averagePrice * 100).toFixed(1)}¢` };
}

export function observationGuard(s: Snapshot, c: Config, now: number): string | null {
  if (now < s.market.startMs || now >= s.market.endMs) return "等待当前轮次行情";
  if (!s.market.acceptingOrders) return "市场未开放交易";
  if (!s.market.anchor) return "缺少本轮开盘基准价，等待下一轮精确边界数据";
  if (!s.reference || s.reference.source !== s.market.source) return "等待与结算规则匹配的 Chainlink 数据";
  const times = [s.at, s.reference.timestamp, ...Object.values(s.books).flatMap(b => [b.timestamp, b.receivedAt])];
  if (times.some(t => !Number.isFinite(t) || now - t > c.maxDataAgeMs || t - now > 2000)) return "行情过期或时钟偏差，跳过本次决策";
  return null;
}

export function dataGuard(s: Snapshot, c: Config, now: number): string | null {
  const guard = observationGuard(s, c, now);
  if (guard) return guard;
  const left = (s.market.endMs - now) / 1000;
  if (left > c.maxSecondsLeft) return "等待入场时间窗口";
  if (left < c.minSecondsLeft) return "临近收盘，停止开仓";
  if (!s.market.fee) return "缺少可靠的手续费参数";
  return null;
}

export function riskGuard(account: Account, c: Config): string | null {
  if (c.dailyLossLimit !== null) {
    if (account.dailyPnl <= -c.dailyLossLimit) return "达到当日已实现亏损上限（UTC）";
    // Include all unsettled stakes in the day's worst-case loss budget.
    const riskBudget = c.dailyLossLimit + Math.min(0, account.dailyPnl) - account.exposure;
    if (riskBudget + 1e-8 < c.tradeUsd) return "当日剩余亏损额度不足（包含未结算仓位）";
  }
  if (account.cash + 1e-8 < c.tradeUsd || account.exposure + c.tradeUsd > c.maxExposure + 1e-8) return "可用余额或总敞口额度不足";
  return null;
}

export function evaluate(s: Snapshot, d: Decision, account: Account, holding: boolean, c: Config, now: number): Signal {
  const wait = (reason: string): Signal => ({ action: "wait", reason });
  const guard = dataGuard(s, c, now) ?? riskGuard(account, c);
  if (guard) return wait(guard);
  if (now - d.at > c.maxDataAgeMs || d.at > now + 2000) return wait("模型结果已过期");
  if (holding) return wait("本轮已有持仓，同一时间最多一笔");
  const candidates: Quote[] = [];
  for (const side of ["up", "down"] as const) {
    if (!Number.isFinite(d.scores[side]) || d.scores[side] < c.minScore || d.scores[side] > 1) continue;
    const b = s.books[side], bid = b.bids[0], ask = b.asks[0];
    if (!bid || !ask || bid.price >= ask.price || ask.price - bid.price > c.maxSpread) continue;
    const q = quoteBuy(b, side, c.tradeUsd, s.market.fee!, c.slippageBuffer);
    if (!q) continue;
    // Edge = Jev probability minus the fee-inclusive cost per share.
    q.edge = d.scores[side] - q.total / q.shares;
    if (q.edge >= c.minEdge) candidates.push(q);
  }
  candidates.sort((a, b) => b.edge - a.edge);
  const quote = candidates[0];
  if (!quote) return wait("评分优势不足，或价差 / 深度未达入场条件");
  return { action: quote.side, quote, reason: `买入 ${quote.side.toUpperCase()}：含费成本 ${(quote.total / quote.shares * 100).toFixed(1)}¢，低于 Jev ${(d.scores[quote.side] * 100).toFixed(1)}¢ 达 ${(quote.edge * 100).toFixed(1)}¢` };
}
