import { afterEach, expect, test } from "bun:test";
import { Engine } from "../src/engine";
import { MemoryStore } from "../src/memory-store";
import { readConfig } from "../src/config";
import { config, now, snapshot } from "./fixtures";

const saved = process.env.TYPESAFE_AI_API_KEY;
afterEach(() => { if (saved === undefined) delete process.env.TYPESAFE_AI_API_KEY; else process.env.TYPESAFE_AI_API_KEY = saved; });

test("an API key echoed in a model or data error never reaches the dashboard state or event log", async () => {
  const key = "tsk_live_TEST_SECRET_1234567890";
  process.env.TYPESAFE_AI_API_KEY = key;
  const store = new MemoryStore(1000);
  const engine = new Engine(config, { start() {}, stop() {}, status: () => "", snapshot: async () => snapshot(), resolve: async () => null },
    { decide: async () => { throw new Error(`401 Unauthorized: Authorization: Bearer ${key}`); } }, store, () => now);
  await engine.tick();
  const exposed = JSON.stringify({ view: engine.view(), history: store.recentEvents(200) });
  expect(engine.error).toContain("[redacted]"); expect(exposed).not.toContain(key);
});
test("CORS_ORIGIN accepts only one exact origin", () => {
  expect(readConfig({ DATA_MODE: "demo" }).corsOrigin).toBeNull();
  expect(readConfig({ DATA_MODE: "demo", CORS_ORIGIN: "https://jev-poly.vercel.app" }).corsOrigin).toBe("https://jev-poly.vercel.app");
  for (const bad of ["*", "https://*.vercel.app", "https://a.vercel.app/path", "jev-poly.vercel.app"])
    expect(() => readConfig({ DATA_MODE: "demo", CORS_ORIGIN: bad })).toThrow();
});

import { publicView } from "../src/public-view";
import { decision } from "./fixtures";

test("REQUIRE_ORIGIN needs an exact CORS_ORIGIN", () => {
  expect(readConfig({ DATA_MODE: "demo" }).requireOrigin).toBe(false);
  expect(readConfig({ DATA_MODE: "demo", CORS_ORIGIN: "https://x.vercel.app", REQUIRE_ORIGIN: "on" }).requireOrigin).toBe(true);
  expect(() => readConfig({ DATA_MODE: "demo", REQUIRE_ORIGIN: "on" })).toThrow();
  expect(() => readConfig({ DATA_MODE: "demo", CORS_ORIGIN: "https://x.vercel.app", REQUIRE_ORIGIN: "yes" })).toThrow();
});
test("public view keeps every field the dashboard renders while trimming history, books, trades and decisions", async () => {
  const store = new MemoryStore(1000), snap = snapshot();
  snap.history = Array.from({ length: 400 }, (_, i) => ({ timestamp: snap.market.startMs + i * 200, price: 84000 + i, source: "chainlink-twap-60s" as const }));
  snap.books.up.asks = Array.from({ length: 20 }, (_, i) => ({ price: .5 + i / 100, size: 10 }));
  const engine = new Engine(config, { start() {}, stop() {}, status: () => "", snapshot: async () => snap, resolve: async () => null }, { decide: async () => decision }, store, () => now);
  await engine.tick();
  const full = engine.view(), view = publicView(full);
  expect(view.snapshot!.history.length).toBe(150); expect(view.snapshot!.history.at(-1)).toEqual(snap.history.at(-1)!);
  expect(view.snapshot!.books.up.asks).toEqual([{ price: .5, size: 10 }]);
  expect(view.snapshot!.market.anchor).toEqual(snap.market.anchor); expect(view.snapshot!.perp).toBe(snap.perp);
  expect(view.decisionPoints[0]!.decision!.rawScores).toEqual(decision.rawScores);
  for (const key of ["account", "signal", "decision", "lastEvaluation", "cadence", "risk", "controls", "serverTime", "feed"] as const) expect(view[key]).toEqual(full[key]);
  expect(JSON.stringify(view).length).toBeLessThan(JSON.stringify(full).length / 2);
});
