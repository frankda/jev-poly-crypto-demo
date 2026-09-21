import { expect, test } from "bun:test";
import { Engine } from "../src/engine";
import { MemoryStore } from "../src/memory-store";
import { readConfig } from "../src/config";
import type { MarketData } from "../src/types";
import { config, decision, now, snapshot } from "./fixtures";

test("LEDGER defaults to sqlite locally and accepts memory for hosted demos", () => {
  expect(config.ledger).toBe("sqlite");
  expect(readConfig({ DATA_MODE: "demo", LEDGER: "memory" }).ledger).toBe("memory");
  expect(() => readConfig({ DATA_MODE: "demo", LEDGER: "redis" })).toThrow();
});
test("memory ledger runs the full buy → hold → sell → re-enter → settle cycle", async () => {
  let bid = .48, end = false;
  const data: MarketData = { start() {}, stop() {}, status: () => "test", resolve: async () => ({ payouts: [1, 0], source: "polymarket" }),
    snapshot: async () => { const v = snapshot(); v.books.up.bids = [{ price: bid, size: 200 }]; v.books.up.asks = [{ price: bid + .02, size: 200 }]; return v; } };
  const s = new MemoryStore(1000);
  const engine = new Engine(config, data, { decide: async () => decision }, s, () => end ? now + 400000 : now);
  await engine.tick(); expect(s.openTrades()).toHaveLength(1);
  bid = .8; await engine.tick(); expect(engine.signal.action).toBe("sell"); expect(s.openTrades()).toHaveLength(0);
  bid = .48; await engine.tick(); expect(s.openTrades()).toHaveLength(1); expect(s.trades()).toHaveLength(2);
  expect(engine.view().decisionPoints).toHaveLength(3);
  const trade = s.openTrades()[0]!;
  expect(s.settle(trade.id, { payouts: [1, 0], source: "polymarket" }, trade.endMs + 1)).toBe(true);
  expect(s.account().settledTrades).toBe(2); expect(s.recentEvents(10).map(e => e.kind)).toContain("paper-exit");
});
test("memory ledger returns copies and keeps a bounded event log", () => {
  const s = new MemoryStore(1000, 5);
  for (let i = 0; i < 20; i++) s.record(now + i, "decision", { market: { slug: "x" }, decision, point: null });
  expect(s.recentEvents(100)).toHaveLength(5); expect(s.recentEvents(1)[0]!.at).toBe(now + 19);
  expect(s.lastEvaluation()?.slug).toBe("x");
  s.open(snapshot(), { side: "up", shares: 10, notional: 5, fee: .1, total: 5.1, averagePrice: .5, edge: .2 }, decision, now);
  s.openTrades()[0]!.total = 999; expect(s.account(now).exposure).toBeCloseTo(5.1);
});
test("CONTROL=off is exposed to the dashboard so hosted visitors cannot pause the engine", () => {
  expect(config.control).toBe(true);
  const hosted = readConfig({ DATA_MODE: "demo", CONTROL: "off" });
  const engine = new Engine(hosted, { start() {}, stop() {}, status: () => "", snapshot: async () => snapshot(), resolve: async () => null }, { decide: async () => decision }, new MemoryStore(1000));
  expect(engine.view().controls).toBe(false);
});
