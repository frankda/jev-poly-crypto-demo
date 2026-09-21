import { expect, test } from "bun:test";
import { PerpFeed } from "../src/binance";
import { modelState } from "../src/model";
import { now, snapshot, startMs } from "./fixtures";

const depth = (E: number, bid: number, bidQty: number, askQty: number) => ({ stream: "btcusdt@depth20@100ms", data: {
  e: "depthUpdate", s: "BTCUSDT", E, b: [[String(bid - 0.1), "1"], [String(bid), String(bidQty)]], a: [[String(bid + 0.1), String(askQty)], [String(bid + 0.2), "1"]] } });
const trade = (T: number, q: number, buyerIsMaker: boolean) => ({ stream: "btcusdt@aggTrade", data: { e: "aggTrade", s: "BTCUSDT", T, p: "84000", q: String(q), m: buyerIsMaker } });
const ref = { chainlinkSpot: { timestamp: now, price: 84000, source: "chainlink-spot" as const }, windowStartMs: startMs };

test("computes book imbalance, taker flow, returns and basis from Binance perp frames", () => {
  const feed = new PerpFeed(); feed.tradesSince = startMs;
  feed.ingest(depth(startMs + 1000, 84000, 1, 1), startMs + 1000);
  feed.ingest(depth(now - 30000, 84010, 1, 1), now - 30000);
  feed.ingest(depth(now, 84042, 3, 1), now);
  feed.ingest(trade(now - 5000, 2, false), now); feed.ingest(trade(now - 5000, 1, true), now);
  feed.ingest(trade(now - 40000, 5, true), now);
  const f = feed.features(now, 15000, ref)!;
  expect(f.mid).toBeCloseTo(84042.05); expect(f.depthImbalance.top5).toBeCloseTo((4 - 2) / 6);
  expect(f.micropriceOffsetBps).toBeGreaterThan(0);
  expect(f.takerFlow.seconds10).toEqual({ buyBtc: 2, sellBtc: 1, imbalance: 1 / 3 });
  expect(f.takerFlow.seconds60?.sellBtc).toBe(6);
  expect(f.returnsBps.seconds30).toBeCloseTo((84042.05 / 84010.05 - 1) * 1e4);
  expect(f.returnsBps.seconds60).toBeCloseTo((84042.05 / 84000.05 - 1) * 1e4);
  expect(f.sinceWindowStartBps).toBeCloseTo((84042.05 / 84000.05 - 1) * 1e4);
  expect(f.basisVsChainlinkSpotBps).toBeCloseTo((84042.05 / 84000 - 1) * 1e4);
});
test("stale, crossed, wrong-symbol or missing data yields no features instead of guesses", () => {
  const feed = new PerpFeed();
  expect(feed.features(now, 15000, ref)).toBeNull();
  feed.ingest({ data: { ...depth(now, 84000, 1, 1).data, s: "ETHUSDT" } }, now);
  feed.ingest({ data: { ...depth(now, 84000, 1, 1).data, b: [["84001", "1"]], a: [["84000", "1"]] } }, now);
  expect(feed.depth).toBeNull();
  feed.ingest(depth(now - 20000, 84000, 1, 1), now - 20000);
  expect(feed.features(now, 15000, ref)).toBeNull();
  feed.ingest(depth(now, 84000, 1, 1), now);
  const f = feed.features(now, 15000, { chainlinkSpot: null, windowStartMs: startMs })!;
  expect(f.basisVsChainlinkSpotBps).toBeNull(); expect(f.sinceWindowStartBps).toBeNull(); expect(f.returnsBps.seconds60).toBeNull();
  feed.ingest(trade(now, 1, false), now);
  const g = feed.features(now + 10001, 15000, { chainlinkSpot: null, windowStartMs: startMs })!;
  expect(g.takerFlow.seconds10).not.toBeNull(); expect(g.takerFlow.seconds30).toBeNull(); expect(g.takerFlow.seconds60).toBeNull();
});
test("Jev state carries perp features as labelled auxiliary input, and null when unavailable", () => {
  expect(modelState(snapshot()).perpFeatures).toBeNull();
  const feed = new PerpFeed(); feed.ingest(depth(now - 2000, 84000, 1, 1), now);
  const s = snapshot(); s.perp = feed.features(now, 15000, ref);
  const state = modelState(s);
  expect(state.perpFeatures?.note).toContain("NOT the settlement source");
  expect(state.perpFeatures?.ageSeconds).toBe(2); expect(state.referenceSource).toBe("chainlink-twap-60s");
});
