import { readConfig } from "../src/config";
import type { Account, Decision, Snapshot } from "../src/types";
export const startMs = 1800000000000;
export const now = startMs + 90000;
export const conditionId = `0x${"a".repeat(64)}`;
export const config = readConfig({ DATA_MODE: "demo" });
export const account: Account = { bankroll: 1000, cash: 1000, exposure: 0, realizedPnl: 0, dailyPnl: 0, openTrades: 0, settledTrades: 0, wins: 0 };
export const decision: Decision = { model: "test", scores: { up: 0.75, down: 0.25 }, rawScores: { up: 1, down: 0 }, at: now, latencyMs: 1, inputTokens: 10 };
export function snapshot(): Snapshot {
  return {
    at: now, market: { slug: `btc-updown-5m-${startMs / 1000}`, conditionId, question: "Bitcoin Up or Down", startMs, endMs: startMs + 300000,
      tokens: { up: "11", down: "22" }, outcomeIndices: { up: 0, down: 1 }, acceptingOrders: true, source: "chainlink-twap-60s",
      resolutionSource: "https://data.chain.link/streams/btc-usd-twap-60s-streams", description: 'Resolves to "Up" when greater than or equal to the opening price.',
      anchor: { price: 84000, source: "gamma-metadata" }, fee: { rate: 0.07, exponent: 1 } },
    reference: { timestamp: now, price: 84100, source: "chainlink-twap-60s" }, history: [], perp: null,
    books: {
      up: { tokenId: "11", timestamp: now, receivedAt: now, minOrderSize: 5, bids: [{ price: 0.48, size: 100 }], asks: [{ price: 0.5, size: 100 }] },
      down: { tokenId: "22", timestamp: now, receivedAt: now, minOrderSize: 5, bids: [{ price: 0.5, size: 100 }], asks: [{ price: 0.52, size: 100 }] },
    },
  };
}
export function eventFixture() {
  const s = snapshot();
  return { eventMetadata: { priceToBeat: "84000" }, markets: [{ slug: s.market.slug, conditionId, question: s.market.question,
    endDate: new Date(s.market.endMs).toISOString(), outcomes: '["Down","Up"]', clobTokenIds: '["22","11"]',
    active: true, closed: false, acceptingOrders: true, feesEnabled: true, feeSchedule: { rate: 0.07, exponent: 1 },
    resolutionSource: s.market.resolutionSource, description: s.market.description }] };
}
