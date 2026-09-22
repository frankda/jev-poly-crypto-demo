import { expect, test } from "bun:test";
import { Engine } from "../src/engine";
import { MemoryStore } from "../src/memory-store";
import { publicView } from "../src/public-view";
import { diffView, headPatch, tailPatch } from "../src/state-patch";
import { applyPatch } from "../web/state-patch.js";
import type { Snapshot } from "../src/types";
import { config, decision, now, snapshot } from "./fixtures";

test("list patches cover append, tail change, reset, prepend-with-drop and no change", () => {
  expect(tailPatch([1, 2, 3], [1, 2, 3, 4])).toEqual({ from: 3, items: [4] });
  expect(tailPatch([1, 2, 3], [1, 2, 9])).toEqual({ from: 2, items: [9] });
  expect(tailPatch([1, 2, 3], [7])).toEqual({ from: 0, items: [7] });
  expect(tailPatch([1, 2], [1, 2])).toBeNull();
  expect(headPatch([3, 2, 1], [4, 3, 2])).toEqual({ head: [4], keep: 2 });
  expect(headPatch([3, 2, 1], [3, 2, 1])).toBeNull();
  expect(headPatch([3, 2, 1], [9, 8])).toEqual({ head: [9, 8], keep: 0 });
});

test("client state rebuilt from patches equals the server's full state across cycles and a round change", async () => {
  let t = now, price = 84100, round = 0;
  const load = (): Snapshot => {
    const s = snapshot();
    s.market.startMs += round * 300000; s.market.endMs += round * 300000; s.market.slug = `btc-updown-5m-${s.market.startMs / 1000}`;
    s.at = t; s.reference = { timestamp: t, price, source: "chainlink-twap-60s" };
    s.history = Array.from({ length: Math.floor((t - s.market.startMs) / 1000) + 1 }, (_, i) => ({ timestamp: s.market.startMs + i * 1000, price: 84000 + i, source: "chainlink-twap-60s" as const }));
    s.books.up.timestamp = s.books.up.receivedAt = s.books.down.timestamp = s.books.down.receivedAt = t;
    return s;
  };
  const engine = new Engine(config, { start() {}, stop() {}, status: () => "", snapshot: async () => load(), resolve: async () => null },
    { decide: async () => ({ ...decision, at: t }) }, new MemoryStore(1000), () => t);
  let server = publicView(engine.view()), client = structuredClone(server), fullBytes = 0, patchBytes = 0;
  for (let i = 0; i < 40; i++) {
    t += 2000; price += 3;
    if (i === 25) { round = 1; t = snapshot().market.startMs + 300000 + 40000; }
    await engine.tick();
    const next = publicView(engine.view()), patch = diffView(server, next);
    client = patch ? applyPatch(client, JSON.parse(JSON.stringify(patch))) : structuredClone(next);
    expect(client).toEqual(JSON.parse(JSON.stringify(next)));
    fullBytes += JSON.stringify(next).length; patchBytes += JSON.stringify(patch ?? next).length;
    server = next;
  }
  // Steady-state patches are a small fraction of resending the full state.
  expect(patchBytes).toBeLessThan(fullBytes / 4);
});

test("history sampling is append-only: one tick per 2 s bucket plus the latest", () => {
  const s = snapshot();
  s.history = Array.from({ length: 301 }, (_, i) => ({ timestamp: s.market.startMs + i * 1000, price: i, source: "chainlink-twap-60s" as const }));
  const engine = new Engine(config, { start() {}, stop() {}, status: () => "", snapshot: async () => s, resolve: async () => null }, { decide: async () => decision }, new MemoryStore(1000));
  engine.latest = s;
  const a = publicView(engine.view()).snapshot!.history;
  s.history.push({ timestamp: s.market.startMs + 301000, price: 999, source: "chainlink-twap-60s" });
  const b = publicView(engine.view()).snapshot!.history;
  expect(a.length).toBeLessThanOrEqual(152); expect(b.at(-1)!.price).toBe(999);
  expect(tailPatch(a, b)!.from).toBeGreaterThanOrEqual(a.length - 1);
});
