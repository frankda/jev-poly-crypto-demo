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
  if (now - d.at > c.maxDataAgeMs || d.at > now + 2000) return hold(`Holding ${label}: model result is stale, not selling`);
  if (!s.market.fee) return hold(`Holding ${label}: no reliable fee schedule, not selling`);
  const bid = s.books[side].bids[0];
  if (!bid || bid.price <= score) return hold(`Holding ${label}: bid ${bid ? (bid.price * 100).toFixed(1) : "—"}¢ is not above Jev ${(score * 100).toFixed(1)}¢`);
  const q = quoteSell(s.books[side], trade.shares, s.market.fee, c.slippageBuffer);
  if (!q) return hold(`Holding ${label}: bid is above Jev but bid depth cannot fill the whole position`);
  return { action: "sell", exit: { ...q, tradeId: trade.id, side, score },
    reason: `Sell ${label}: bid ${(bid.price * 100).toFixed(1)}¢ is above Jev ${(score * 100).toFixed(1)}¢, average fill ${(q.averagePrice * 100).toFixed(1)}¢` };
}

export function observationGuard(s: Snapshot, c: Config, now: number): string | null {
  if (now < s.market.startMs || now >= s.market.endMs) return "Waiting for current round data";
  if (!s.market.acceptingOrders) return "Market is not accepting orders";
  if (!s.market.anchor) return "No price to beat for this round; waiting for the next exact opening tick";
  if (!s.reference || s.reference.source !== s.market.source) return "Waiting for the Chainlink stream that matches the settlement rules";
  const times = [s.at, s.reference.timestamp, ...Object.values(s.books).flatMap(b => [b.timestamp, b.receivedAt])];
  if (times.some(t => !Number.isFinite(t) || now - t > c.maxDataAgeMs || t - now > 2000)) return "Stale data or clock skew; skipping this decision";
  return null;
}

export function dataGuard(s: Snapshot, c: Config, now: number): string | null {
  const guard = observationGuard(s, c, now);
  if (guard) return guard;
  const left = (s.market.endMs - now) / 1000;
  if (left > c.maxSecondsLeft) return "Waiting for the entry window";
  if (left < c.minSecondsLeft) return "Too close to the close; no new entries";
  if (!s.market.fee) return "No reliable fee schedule";
  return null;
}

export function riskGuard(account: Account, c: Config): string | null {
  if (c.dailyLossLimit !== null) {
    if (account.dailyPnl <= -c.dailyLossLimit) return "Daily realized loss limit reached (UTC)";
    // Include all unsettled stakes in the day's worst-case loss budget.
    const riskBudget = c.dailyLossLimit + Math.min(0, account.dailyPnl) - account.exposure;
    if (riskBudget + 1e-8 < c.tradeUsd) return "Not enough daily loss budget left (including open positions)";
  }
  if (account.cash + 1e-8 < c.tradeUsd || account.exposure + c.tradeUsd > c.maxExposure + 1e-8) return "Insufficient cash or exposure headroom";
  return null;
}

export function evaluate(s: Snapshot, d: Decision, account: Account, holding: boolean, c: Config, now: number): Signal {
  const wait = (reason: string): Signal => ({ action: "wait", reason });
  const guard = dataGuard(s, c, now) ?? riskGuard(account, c);
  if (guard) return wait(guard);
  if (now - d.at > c.maxDataAgeMs || d.at > now + 2000) return wait("Model result is stale");
  if (holding) return wait("Position already open; at most one at a time");
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
  if (!quote) return wait("Edge too small, or spread / depth does not meet entry rules");
  return { action: quote.side, quote, reason: `Buy ${quote.side.toUpperCase()}: cost incl. fees ${(quote.total / quote.shares * 100).toFixed(1)}¢ is ${(quote.edge * 100).toFixed(1)}¢ below Jev ${(d.scores[quote.side] * 100).toFixed(1)}¢` };
}
