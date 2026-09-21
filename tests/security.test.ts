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
