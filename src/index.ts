import { closeSync, mkdirSync, openSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { readConfig } from "./config";
import { DemoData } from "./demo";
import { Engine } from "./engine";
import { JevModel, MockModel } from "./model";
import { PolymarketData } from "./polymarket";
import { MemoryStore } from "./memory-store";
import { Store } from "./store";
import type { Ledger } from "./types";

const config = readConfig();
if (config.dataMode === "demo" && config.model !== "mock") throw new Error("Demo mode uses MODEL=mock. Use live data for Jev experiments.");
function sqliteLedger(): Ledger {
  mkdirSync(config.dataDir, { recursive: true });
  const dbPath = resolve(config.dataDir, `${config.dataMode}-${config.model}.sqlite`);
  const lockPath = `${dbPath}.lock`;
  try {
    const fd = openSync(lockPath, "wx", 0o600); writeFileSync(fd, String(process.pid)); closeSync(fd);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e;
    const pid = Number(readFileSync(lockPath, "utf8"));
    // `bun --watch` restarts via exec in the same PID without running exit handlers, so our own PID is a leftover lock.
    let stale = pid === process.pid;
    if (!stale && Number.isInteger(pid) && pid > 0) {
      try { process.kill(pid, 0); } catch (e) { stale = (e as NodeJS.ErrnoException).code === "ESRCH"; }
    }
    if (!stale) throw new Error(`Ledger is locked by process ${pid}. Stop that instance before starting another.`);
    unlinkSync(lockPath);
    const fd = openSync(lockPath, "wx", 0o600); writeFileSync(fd, String(process.pid)); closeSync(fd);
  }
  process.on("exit", () => { try { if (readFileSync(lockPath, "utf8") === String(process.pid)) unlinkSync(lockPath); } catch {} });
  return new Store(dbPath, config.bankroll);
}
const store = config.ledger === "memory" ? new MemoryStore(config.bankroll) : sqliteLedger();
const engine = new Engine(config, config.dataMode === "demo" ? new DemoData() : new PolymarketData({ perp: config.perpFeatures, maxDataAgeMs: config.maxDataAgeMs }), config.model === "jev" ? new JevModel(config) : new MockModel(config), store);
const webRoot = resolve(import.meta.dir, "../web");
const assets: Record<string, string> = { "/": "index.html", "/app.js": "app.js", "/config.js": "config.js", "/decision-view.js": "decision-view.js", "/style.css": "style.css" };
const securityHeaders = { "X-Content-Type-Options": "nosniff", "Cache-Control": "no-store", "Content-Security-Policy": "default-src 'self'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self' data:; frame-ancestors 'none'" };

// A separately hosted dashboard (e.g. Vercel) may read the public GET endpoints; only that exact origin is allowed.
const cors = (request: Request): Record<string, string> =>
  config.corsOrigin && request.headers.get("origin") === config.corsOrigin ? { "Access-Control-Allow-Origin": config.corsOrigin, "Vary": "Origin" } : { "Vary": "Origin" };
// Serialize the state once per change and share it across all SSE clients.
// Reuse for at most 1 s so serverTime (used for the countdown) stays accurate.
let stateCache: { version: number; at: number; body: string } | null = null, stateVersion = 0;
engine.subscribe(() => { stateVersion++; });
const stateJson = () => {
  const now = Date.now();
  if (!stateCache || stateCache.version !== stateVersion || now - stateCache.at > 1000) stateCache = { version: stateVersion, at: now, body: JSON.stringify(engine.view()) };
  return stateCache.body;
};
let sseClients = 0;

const server = Bun.serve({
  hostname: config.host, port: config.port, idleTimeout: 30,
  // Never render Bun's development error page (stack traces, source excerpts) to visitors.
  development: false,
  error() { return new Response("Internal error", { status: 500 }); },
  async fetch(request) {
    const url = new URL(request.url);
    if (request.method === "POST" && url.pathname === "/api/control") {
      // Hosted demos (CONTROL=off) must not let any visitor pause the shared engine.
      if (!config.control) return new Response("Control disabled", { status: 403 });
      if (request.headers.get("origin") !== url.origin || !request.headers.get("content-type")?.startsWith("application/json")) return new Response("Forbidden", { status: 403 });
      try {
        const body = await request.json();
        if (typeof body?.paused !== "boolean") return new Response("Expected paused boolean", { status: 400 });
        engine.setPaused(body.paused); return Response.json({ paused: engine.paused }, { headers: securityHeaders });
      } catch { return new Response("Invalid request", { status: 400 }); }
    }
    if (request.method !== "GET") return new Response("Method not allowed", { status: 405 });
    if (url.pathname === "/api/state") return new Response(stateJson(), { headers: { ...securityHeaders, ...cors(request), "Content-Type": "application/json" } });
    if (url.pathname === "/api/history") return Response.json(store.recentEvents(200), { headers: { ...securityHeaders, ...cors(request) } });
    if (url.pathname === "/health") {
      const ready = engine.updatedAt !== null && Date.now() - engine.updatedAt < 90000 && engine.error === null;
      return Response.json({ ready, mode: "paper", dataMode: config.dataMode, model: config.model, error: engine.error }, { status: ready ? 200 : 503, headers: { ...securityHeaders, ...cors(request) } });
    }
    if (url.pathname === "/events") {
      if (sseClients >= config.maxSseClients) return new Response("Too many viewers, retry later", { status: 503, headers: { ...securityHeaders, ...cors(request), "Retry-After": "30" } });
      sseClients++;
      let cleanup = () => {}, closed = false;
      const stream = new ReadableStream<Uint8Array>({
        start(controller) {
          const encoder = new TextEncoder();
          const send = () => { try { controller.enqueue(encoder.encode(`event: state\ndata: ${stateJson()}\n\n`)); } catch { cleanup(); } };
          const unsubscribe = engine.subscribe(send);
          const heartbeat = setInterval(send, 10000);
          cleanup = () => {
            if (closed) return; closed = true; sseClients--;
            clearInterval(heartbeat); unsubscribe(); request.signal.removeEventListener("abort", cleanup);
          };
          request.signal.addEventListener("abort", cleanup, { once: true }); send();
        },
        cancel() { cleanup(); },
      });
      return new Response(stream, { headers: { ...securityHeaders, ...cors(request), "Content-Type": "text/event-stream", "Connection": "keep-alive" } });
    }
    const file = assets[url.pathname];
    if (file) return new Response(Bun.file(resolve(webRoot, file)), { headers: securityHeaders });
    return new Response("Not found", { status: 404 });
  },
});
let stopping = false;
const shutdown = async () => {
  if (stopping) return; stopping = true;
  await server.stop(true); await engine.stop(); store.close(); process.exit(0);
};
process.on("SIGINT", shutdown); process.on("SIGTERM", shutdown);
console.log(`JEV / POLY → http://${config.host}:${server.port} · PAPER · ${config.dataMode} data · ${config.model} model · ${config.ledger} ledger`);
engine.start();
