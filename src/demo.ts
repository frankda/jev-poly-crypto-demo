import type { Book, MarketData, PerpFeatures, Resolution, Snapshot, Tick } from "./types";

const base = 84000;
// Deterministic synthetic path, shared across restarts for consistent demo settlement.
const price = (t: number) => base + 85 * Math.sin(t / 45000) + 30 * Math.sin(t / 17000);

const flow = (buy: number, sell: number) => ({ buyBtc: buy, sellBtc: sell, imbalance: (buy - sell) / (buy + sell) });
const bps = (a: number, b: number) => (a / b - 1) * 1e4;
function syntheticPerp(now: number, startMs: number): PerpFeatures {
  const mid = price(now) + 12, slope = Math.cos(now / 45000);
  return { source: "demo", at: now, mid, spreadBps: 0.01, micropriceOffsetBps: 0.004 * slope,
    depthImbalance: { top5: 0.3 * slope, top20: 0.15 * slope },
    takerFlow: { seconds10: flow(4 + 2 * slope, 4 - 2 * slope), seconds30: flow(12 + 5 * slope, 12 - 5 * slope), seconds60: flow(25 + 8 * slope, 25 - 8 * slope) },
    returnsBps: { seconds10: bps(mid, price(now - 10000) + 12), seconds30: bps(mid, price(now - 30000) + 12), seconds60: bps(mid, price(now - 60000) + 12) },
    sinceWindowStartBps: bps(mid, price(startMs) + 12), basisVsChainlinkSpotBps: bps(mid, price(now)) };
}

export class DemoData implements MarketData {
  start() {}
  stop() {}
  status() { return "离线演示 · 合成行情 · Mock 模型"; }
  async snapshot(now = Date.now()): Promise<Snapshot> {
    const startMs = Math.floor(now / 300000) * 300000;
    const slug = `btc-updown-5m-${startMs / 1000}`;
    const history: Tick[] = [];
    for (let t = now - 300000; t <= now; t += 1000) history.push({ timestamp: t, price: price(t), source: "chainlink-twap-60s" });
    // Deliberately independent synthetic quotes so the demonstration can exercise entries.
    const upAsk = Math.round((0.48 + 0.06 * Math.sin(now / 30000)) * 100) / 100;
    const book = (side: "up" | "down", ask: number): Book => ({
      tokenId: `demo-${side}`, timestamp: now, receivedAt: now, minOrderSize: 5,
      bids: [{ price: ask - 0.02, size: 150 }, { price: ask - 0.03, size: 300 }],
      asks: [{ price: ask, size: 120 }, { price: ask + 0.01, size: 250 }],
    });
    return { at: now, market: {
      slug, conditionId: `demo-${startMs}`, question: "Bitcoin Up or Down · 5 minutes (DEMO)", startMs, endMs: startMs + 300000,
      tokens: { up: "demo-up", down: "demo-down" }, outcomeIndices: { up: 0, down: 1 },
      acceptingOrders: true, source: "chainlink-twap-60s", resolutionSource: "synthetic-demo",
      description: "Synthetic demo; not an actual Chainlink or Polymarket observation.", fee: { rate: 0.07, exponent: 1 },
      anchor: { price: price(startMs), source: "demo" },
    }, books: { up: book("up", upAsk), down: book("down", 1.02 - upAsk) }, reference: history.at(-1)!, history, perp: syntheticPerp(now, startMs) };
  }
  async resolve(conditionId: string): Promise<Resolution | null> {
    const startMs = Number(conditionId.replace("demo-", ""));
    if (!Number.isFinite(startMs) || Date.now() < startMs + 300000) return null;
    return { source: "demo", payouts: price(startMs + 300000) >= price(startMs) ? [1, 0] : [0, 1] };
  }
}
