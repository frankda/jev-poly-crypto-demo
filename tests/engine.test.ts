import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { Database } from "bun:sqlite";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Engine } from "../src/engine";
import { Store } from "../src/store";
import { quoteBuy } from "../src/policy";
import type { Model } from "../src/model";
import type { MarketData, Snapshot } from "../src/types";
import { config, decision, now, snapshot } from "./fixtures";

const stores: Store[] = []; afterEach(() => { for (const s of stores.splice(0)) s.close(); });
const store = () => { const s = new Store(":memory:", 1000); stores.push(s); return s; };
function data(load: () => Snapshot = snapshot): MarketData {
  return { start() {}, stop() {}, status: () => "test", snapshot: async () => load(), resolve: async () => null };
}
const goodModel: Model = { decide: async () => decision };

test("model keeps evaluating after a fill while an open position prevents duplicate entries", async () => {
  let reads = 0, calls = 0;
  const s = store(), engine = new Engine(config, data(() => { reads++; return snapshot(); }), { decide: async () => { calls++; return decision; } }, s, () => now);
  await engine.tick(); await engine.tick();
  expect(reads).toBe(4); expect(calls).toBe(2); expect(s.openTrades()).toHaveLength(1);
  expect(engine.signal.reason).toContain("Holding UP");
  expect(engine.view().decisionPoints).toHaveLength(2);
  expect(engine.view().decisionPoints[0]!.id).not.toBe(engine.view().decisionPoints[1]!.id);
  expect(s.account(now).cash).toBeCloseTo(990); expect(s.recentEvents().some(e => e.kind === "paper-fill")).toBe(true);
});
test("refreshing quotes after inference can invalidate an entry", async () => {
  let reads = 0;
  const s = store(), engine = new Engine(config, data(() => {
    const v = snapshot(); if (++reads > 1) { v.books.up.asks[0]!.price = .8; v.books.up.bids[0]!.price = .79; } return v;
  }), goodModel, s, () => now);
  await engine.tick(); expect(s.openTrades()).toHaveLength(0); expect(engine.signal.action).toBe("wait");
  const audit = s.recentEvents().find(e => e.kind === "model-evaluation");
  expect(audit?.data.input.books.up.asks[0].price).toBe(.5);
  expect(engine.latest?.books.up.asks[0]?.price).toBe(.8);
});

test("latest valid evaluation is restored for the dashboard without another model call", async () => {
  const s = store(), engine = new Engine(config, data(), goodModel, s, () => now);
  await engine.tick();
  const restarted = new Engine(config, data(), goodModel, s, () => now);
  expect(restarted.lastEvaluation?.decision.scores.up).toBe(.75);
  expect(restarted.decision).toBeNull();
  await restarted.tick();
  expect(restarted.view().decisionPoints).toHaveLength(2);
});

test("model observes outside the entry window while execution still waits", async () => {
  let calls = 0;
  const early = snapshot(); early.market.startMs = now - 10000; early.market.endMs = now + 290000;
  const s = store(), engine = new Engine(config, data(() => early), { decide: async () => { calls++; return decision; } }, s, () => now);
  await engine.tick();
  expect(calls).toBe(1); expect(engine.decision).not.toBeNull(); expect(s.openTrades()).toHaveLength(0);
  expect(engine.signal.reason).toBe("Waiting for the entry window");
});

test("loss budget blocks new orders without hiding fresh model opinions", async () => {
  const s = store(), engine = new Engine({ ...config, dailyLossLimit: 5 }, data(), goodModel, s, () => now);
  await engine.tick();
  expect(engine.decision).not.toBeNull(); expect(engine.view().decisionPoints).toHaveLength(1);
  expect(s.openTrades()).toHaveLength(0); expect(engine.signal.reason).toContain("daily loss budget");
});

test("missing opening reference still prevents inference and chart decision markers", async () => {
  const v = snapshot(); v.market.anchor = null;
  let calls = 0;
  const s = store(), engine = new Engine(config, data(() => v), { decide: async () => { calls++; return decision; } }, s, () => now);
  await engine.tick();
  expect(calls).toBe(0); expect(engine.view().decisionPoints).toHaveLength(0);
});

test("slow official settlement does not block new market decisions", async () => {
  const s = store(), old = snapshot(); old.market.endMs = now - 1; old.market.conditionId = "old-condition";
  s.open(old, quoteBuy(old.books.up, "up", 10, old.market.fee!, .01)!, decision, now - 300000);
  let release!: () => void;
  const feed = data(); feed.resolve = () => new Promise(resolve => { release = () => resolve(null); });
  const engine = new Engine(config, feed, goodModel, s, () => now);
  await engine.tick();
  expect(engine.decision).not.toBeNull(); expect(engine.view().cadence.stage).toBe("idle");
  release(); await engine.stop();
});
test("window rollover or changed opening benchmark discards a prediction", async () => {
  for (const change of ["condition", "anchor"]) {
    let reads = 0;
    const s = store(), engine = new Engine(config, data(() => {
      const v = snapshot(); if (++reads > 1) { if (change === "condition") v.market.conditionId = "new"; else v.market.anchor!.price = 85000; } return v;
    }), goodModel, s, () => now);
    await engine.tick(); expect(s.openTrades()).toHaveLength(0); expect(engine.decision).toBeNull();
  }
});
test("timeout rejects a model even when the provider ignores cancellation", async () => {
  const s = store(), engine = new Engine({ ...config, modelTimeoutMs: 20 }, data(), { decide: () => new Promise(() => {}) }, s, () => now);
  await engine.tick(); expect(s.openTrades()).toHaveLength(0); expect(engine.error).toContain("timed out");
});
test("concurrent ticks are coalesced; pausing an in-flight model prevents entry", async () => {
  let started!: () => void;
  const called = new Promise<void>(resolve => { started = resolve; });
  let calls = 0;
  const s = store(), engine = new Engine(config, data(), { decide: async () => { calls++; started(); return new Promise(() => {}); } }, s, () => now);
  const first = engine.tick(); await called; await engine.tick(); engine.setPaused(true); await first;
  expect(calls).toBe(1); expect(s.openTrades()).toHaveLength(0);
});
test("data failure preserves existing positions and does not fabricate settlement", async () => {
  const s = store(), good = new Engine(config, data(), goodModel, s, () => now); await good.tick();
  const failed = data(); failed.snapshot = async () => { throw new Error("HTTP 403"); };
  const engine = new Engine(config, failed, goodModel, s, () => now + 400000);
  await engine.tick(); expect(s.openTrades()).toHaveLength(1); expect(s.account().realizedPnl).toBe(0); expect(engine.error).toContain("403");
});
test("ledger survives restart, prevents a duplicate open position and credits official settlement exactly once", () => {
  const dir = mkdtempSync(join(tmpdir(), "jev-test-"));
  try {
    const path = join(dir, "paper.sqlite"), s = snapshot();
    // Reverse token index to prove settlement never assumes Up is outcome 0.
    s.market.outcomeIndices.up = 1;
    const q = quoteBuy(s.books.up, "up", 10, s.market.fee!, .01)!;
    const first = new Store(path, 1000); expect(first.open(s, q, decision, now)).toBe(true); first.close();
    const reopened = new Store(path, 1000);
    expect(reopened.open(s, q, decision, now)).toBe(false); const trade = reopened.openTrades()[0]!;
    expect(reopened.settle(trade.id, { payouts: [0, 1], source: "polymarket" }, now)).toBe(false);
    expect(reopened.settle(trade.id, { payouts: [0, 1], source: "polymarket" }, s.market.endMs + 1)).toBe(true);
    expect(reopened.settle(trade.id, { payouts: [0, 1], source: "polymarket" }, s.market.endMs + 2)).toBe(false);
    expect(reopened.account(s.market.endMs + 1).cash).toBeCloseTo(990 + q.shares);
    expect(reopened.account(s.market.endMs + 1).exposure).toBe(0); reopened.close();
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("holds after entry, sells once the bid exceeds Jev's probability, then may re-enter the same round", async () => {
  let bid = .48, calls = 0;
  const load = () => { const v = snapshot(); v.books.up.bids = [{ price: bid, size: 200 }]; v.books.up.asks = [{ price: bid + .02, size: 200 }]; return v; };
  const s = store(), engine = new Engine(config, data(load), { decide: async () => { calls++; return decision; } }, s, () => now);
  await engine.tick(); expect(s.openTrades()).toHaveLength(1);
  const cost = s.openTrades()[0]!.total, shares = s.openTrades()[0]!.shares;
  bid = .75; await engine.tick();
  expect(engine.signal.action).toBe("wait"); expect(engine.signal.reason).toContain("is not above Jev");
  bid = .8; await engine.tick();
  expect(engine.signal.action).toBe("sell"); expect(s.openTrades()).toHaveLength(0);
  const t = s.trades(1)[0]!;
  expect(t.exit?.averagePrice).toBeCloseTo(.8); expect(t.payout).toBeCloseTo(shares * (.8 - .07 * .8 * .2));
  expect(t.pnl).toBeCloseTo(t.payout! - cost); expect(s.account(now).cash).toBeCloseTo(1000 + t.pnl!);
  expect(s.recentEvents().some(e => e.kind === "paper-exit")).toBe(true);
  bid = .48; await engine.tick();
  expect(engine.signal.action).toBe("up"); expect(s.openTrades()).toHaveLength(1); expect(s.trades()).toHaveLength(2); expect(calls).toBe(4);
  await engine.tick(); expect(s.trades()).toHaveLength(2); expect(engine.signal.reason).toContain("Holding UP");
});

test("old one-trade-per-round ledgers migrate in place without losing positions", () => {
  const dir = mkdtempSync(join(tmpdir(), "ledger-")), path = join(dir, "old.sqlite");
  try {
    const old = new Database(path);
    old.exec(`CREATE TABLE meta(key TEXT PRIMARY KEY, value TEXT NOT NULL); INSERT INTO meta VALUES ('bankroll','1000');
      CREATE TABLE trades(id INTEGER PRIMARY KEY, condition_id TEXT UNIQUE NOT NULL, opened_at INTEGER NOT NULL, settled_at INTEGER, data TEXT NOT NULL);`);
    old.query("INSERT INTO trades(condition_id,opened_at,data) VALUES(?,?,?)").run("c1", now, JSON.stringify({ side: "down", total: 10, settledAt: null }));
    old.close();
    const s = new Store(path, 1000);
    expect(s.openTrades()).toHaveLength(1); expect(s.openTrades()[0]!.side).toBe("down");
    s.db.query("INSERT INTO trades(condition_id,opened_at,data) VALUES(?,?,?)").run("c1", now, "{}");
    expect(s.trades()).toHaveLength(2);
    s.close(); new Store(path, 1000).close();
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
