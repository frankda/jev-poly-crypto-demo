import { closeSync, mkdirSync, openSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { readConfig } from "./config";
import { DemoData } from "./demo";
import { Engine } from "./engine";
import { JevModel, MockModel } from "./model";
import { PolymarketData } from "./polymarket";
import { publicView } from "./public-view";
import { diffView } from "./state-patch";
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
  return new Store(dbPath, config.bankroll, config.persistAllEvents);
}
const store = config.ledger === "memory" ? new MemoryStore(config.bankroll) : sqliteLedger();
const engine = new Engine(config, config.dataMode === "demo" ? new DemoData() : new PolymarketData({ perp: config.perpFeatures, maxDataAgeMs: config.maxDataAgeMs }), config.model === "jev" ? new JevModel(config) : new MockModel(config), store);
const webRoot = resolve(import.meta.dir, "../web");
const assets: Record<string, string> = { "/": "index.html", "/app.js": "app.js", "/config.js": "config.js", "/decision-view.js": "decision-view.js", "/state-patch.js": "state-patch.js", "/style.css": "style.css" };
const securityHeaders = { "X-Content-Type-Options": "nosniff", "Cache-Control": "no-store", "Content-Security-Policy": "default-src 'self'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self' data:; frame-ancestors 'none'" };

// A separately hosted dashboard (e.g. Vercel) may read the public GET endpoints; only that exact origin is allowed.
const cors = (request: Request): Record<string, string> =>
  config.corsOrigin && request.headers.get("origin") === config.corsOrigin ? { "Access-Control-Allow-Origin": config.corsOrigin, "Vary": "Origin" } : { "Vary": "Origin" };
// One broadcaster for all viewers: each change is diffed once against the previous broadcast and the same bytes go
// to every client. A new client first gets the last broadcast full state, which is exactly what the next patch applies to.
type Client = { controller: ReadableStreamDefaultController<Uint8Array>; close: () => void };
const clients = new Set<Client>();
const encoder = new TextEncoder();
const MAX_BACKLOG = 50; // queued messages before a slow viewer is dropped (it reconnects and resyncs)
let lastView: ReturnType<typeof publicView> | null = null, lastFull = "";
function broadcast() {
  const next = publicView(engine.view());
  const patch = diffView(lastView, next);
  lastView = next; lastFull = JSON.stringify(next);
  if (!clients.size || (patch && !Object.keys(patch).length)) return;
  const bytes = encoder.encode(patch ? `event: patch\ndata: ${JSON.stringify(patch)}\n\n` : `event: state\ndata: ${lastFull}\n\n`);
  for (const client of clients) {
    if ((client.controller.desiredSize ?? 0) < -MAX_BACKLOG) { client.close(); continue; }
    try { client.controller.enqueue(bytes); } catch { client.close(); }
  }
}
engine.subscribe(broadcast);
setInterval(broadcast, 10000); // keeps serverTime fresh and connections alive between cycles
const currentFull = () => { if (!lastView) broadcast(); return lastFull; };

const server = Bun.serve({
  hostname: config.host, port: config.port, idleTimeout: 30,
  // Never render Bun's development error page (stack traces, source excerpts) to visitors.
  development: false,
  error() { return new Response("Internal error", { status: 500 }); },
  async fetch(request) {
    const url = new URL(request.url);
    // REQUIRE_ORIGIN=on: serve only the configured dashboard origin (browsers always send Origin on these cross-site
    // requests). Blocks direct visits, other sites and casual scripts; a forged header is not stopped, so this is not auth.
    if (config.requireOrigin && request.headers.get("origin") !== config.corsOrigin) return new Response("Forbidden", { status: 403, headers: securityHeaders });
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
    if (url.pathname === "/api/state") return new Response(currentFull(), { headers: { ...securityHeaders, ...cors(request), "Content-Type": "application/json" } });
    if (url.pathname === "/api/history") return Response.json(store.recentEvents(200), { headers: { ...securityHeaders, ...cors(request) } });
    if (url.pathname === "/health") {
      const ready = engine.updatedAt !== null && Date.now() - engine.updatedAt < 90000 && engine.error === null;
      return Response.json({ ready, mode: "paper", dataMode: config.dataMode, model: config.model, error: engine.error }, { status: ready ? 200 : 503, headers: { ...securityHeaders, ...cors(request) } });
    }
    if (url.pathname === "/events") {
      if (clients.size >= config.maxSseClients) return new Response("Too many viewers, retry later", { status: 503, headers: { ...securityHeaders, ...cors(request), "Retry-After": "30" } });
      let client: Client | undefined;
      const stream = new ReadableStream<Uint8Array>({
        start(controller) {
          let closed = false;
          const c: Client = { controller, close: () => {
            if (closed) return; closed = true; clients.delete(c);
            request.signal.removeEventListener("abort", c.close);
            try { controller.close(); } catch {}
          } };
          client = c;
          request.signal.addEventListener("abort", c.close, { once: true });
          controller.enqueue(encoder.encode(`event: state\ndata: ${currentFull()}\n\n`));
          clients.add(c);
        },
        cancel() { client?.close(); },
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
