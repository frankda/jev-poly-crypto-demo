import { z } from "zod";
import { PerpFeed } from "./binance";
import type { Book, Fee, Market, MarketData, PriceSource, Resolution, Snapshot, Tick } from "./types";

const finite = z.union([z.number(), z.string().min(1)]).transform(Number).pipe(z.number().finite());
const positive = finite.pipe(z.number().positive());
const object = z.record(z.string(), z.unknown());
const arrayField = (value: unknown): unknown[] => z.array(z.unknown()).parse(typeof value === "string" ? JSON.parse(value) : value);

export async function getJson(url: string, init?: RequestInit): Promise<unknown> {
  const response = await fetch(url, { ...init, signal: AbortSignal.timeout(10000), headers: { Accept: "application/json", ...init?.headers } });
  if (!response.ok) throw new Error(`${new URL(url).hostname}: HTTP ${response.status}${response.status === 403 ? " (access denied)" : ""}`);
  return response.json();
}

export function parseFee(value: unknown): Fee | null {
  const parsed = z.object({ rate: finite.pipe(z.number().min(0).max(1)), exponent: finite.pipe(z.number().min(0).max(5)) }).safeParse(value);
  return parsed.success ? parsed.data : null;
}

export function priceSource(url: string): PriceSource {
  const u = new URL(url);
  if (u.hostname !== "data.chain.link") throw new Error("Unsupported resolution source: expected Chainlink BTC/USD");
  if (/\/btc-usd-twap-60s-streams\/?$/.test(u.pathname)) return "chainlink-twap-60s";
  if (/\/btc-usd-twap-30s-streams\/?$/.test(u.pathname)) return "chainlink-twap-30s";
  if (/\/btc-usd(?:-streams)?\/?$/.test(u.pathname)) return "chainlink-spot";
  throw new Error("Unsupported Chainlink stream; market rules need review");
}

export function parseMarket(eventValue: unknown, slug: string): Market {
  const event = object.parse(eventValue);
  const raw = z.array(object).parse(event.markets).find(m => m.slug === slug);
  if (!raw) throw new Error("No exact BTC 5-minute market found");
  if (!/^btc-updown-5m-\d+$/.test(slug)) throw new Error("Invalid BTC 5-minute slug");
  const startMs = Number(slug.split("-").at(-1)) * 1000;
  const endMs = Date.parse(z.string().parse(raw.endDate));
  if (startMs % 300000 !== 0 || endMs - startMs !== 300000) throw new Error("Market is not an exact 5-minute window");
  const outcomes = arrayField(raw.outcomes).map(v => z.string().parse(v).toLowerCase());
  const ids = arrayField(raw.clobTokenIds).map(v => z.string().regex(/^\d+$/).parse(v));
  const up = outcomes.indexOf("up"), down = outcomes.indexOf("down");
  if (outcomes.length !== 2 || ids.length !== 2 || up < 0 || down < 0 || ids[up] === ids[down]) throw new Error("Expected distinct Up/Down outcome tokens");
  const description = z.string().parse(raw.description ?? event.description);
  if (!/greater than or equal/i.test(description) || !/"Up"/i.test(description)) throw new Error("Unrecognized Up/Down settlement rule");
  const resolutionSource = z.string().parse(raw.resolutionSource ?? event.resolutionSource);
  const metadata = object.safeParse(event.eventMetadata);
  const anchorValue = positive.safeParse(metadata.success ? metadata.data.priceToBeat : undefined);
  return {
    slug, conditionId: z.string().regex(/^0x[0-9a-fA-F]{64}$/).parse(raw.conditionId),
    question: z.string().parse(raw.question), startMs, endMs,
    tokens: { up: ids[up]!, down: ids[down]! }, outcomeIndices: { up, down },
    acceptingOrders: raw.active === true && raw.closed === false && raw.acceptingOrders === true,
    source: priceSource(resolutionSource), resolutionSource, description,
    fee: raw.feesEnabled === false ? { rate: 0, exponent: 1 } : parseFee(raw.feeSchedule),
    anchor: anchorValue.success ? { price: anchorValue.data, source: "gamma-metadata" } : null,
  };
}

export function parseBook(value: unknown, tokenId: string, receivedAt: number): Book {
  const level = z.object({ price: finite.pipe(z.number().gt(0).lt(1)), size: positive });
  const b = z.object({ asset_id: z.string(), timestamp: positive, bids: z.array(level), asks: z.array(level), min_order_size: positive }).parse(value);
  if (b.asset_id !== tokenId) throw new Error("Order book token mismatch");
  return { tokenId, bids: b.bids.sort((a, b) => b.price - a.price), asks: b.asks.sort((a, b) => a.price - b.price), timestamp: b.timestamp, receivedAt, minOrderSize: b.min_order_size };
}

export function parseResolution(value: unknown, conditionId: string): Resolution | null {
  const rows = z.object({ data: z.array(object) }).parse(value).data;
  const row = rows.find(r => (r.condition_id ?? r.condition) === conditionId && r.status === "resolved");
  if (!row) return null;
  const payouts = z.tuple([z.number().int().min(0).max(1000000), z.number().int().min(0).max(1000000)]).safeParse(row.payouts);
  if (!payouts.success || payouts.data[0] + payouts.data[1] !== 1000000) return null;
  return { payouts: [payouts.data[0] / 1e6, payouts.data[1] / 1e6], source: "polymarket" };
}

const topics: Record<string, PriceSource> = {
  crypto_prices_chainlink: "chainlink-spot", crypto_prices_twap_thirty: "chainlink-twap-30s", crypto_prices_twap_sixty: "chainlink-twap-60s",
};
export class ReferenceFeed {
  ticks: Tick[] = [];
  private socket?: WebSocket;
  private heartbeat?: ReturnType<typeof setInterval>;
  private reconnect?: ReturnType<typeof setTimeout>;
  private stopped = true;
  private lastMessage = 0;
  private retries = 0;
  status = "Waiting for Chainlink RTDS";

  ingest(value: unknown, now = Date.now()) {
    const msg = object.safeParse(value);
    if (!msg.success || typeof msg.data.topic !== "string") return;
    const source = topics[msg.data.topic];
    const payload = object.safeParse(msg.data.payload);
    if (!source || !payload.success || payload.data.symbol !== "btc/usd") return;
    const entries = Array.isArray(payload.data.data) ? payload.data.data : [payload.data];
    for (const item of entries) {
      const parsed = z.object({ timestamp: positive, value: positive }).safeParse(item);
      if (!parsed.success || parsed.data.timestamp > now + 2000 || parsed.data.timestamp < now - 1800000) continue;
      const tick = { source, timestamp: parsed.data.timestamp, price: parsed.data.value };
      const index = this.ticks.findIndex(t => t.source === source && t.timestamp === tick.timestamp);
      if (index >= 0) this.ticks[index] = tick; else this.ticks.push(tick);
    }
    this.ticks = this.ticks.filter(t => t.timestamp >= now - 1800000).sort((a, b) => a.timestamp - b.timestamp).slice(-10000);
  }
  start() { this.stopped = false; this.connect(); }
  stop() {
    this.stopped = true;
    clearTimeout(this.reconnect); clearInterval(this.heartbeat);
    this.socket?.close();
  }
  private connect() {
    if (this.stopped) return;
    this.status = "Connecting to Chainlink RTDS…";
    const ws = this.socket = new WebSocket("wss://ws-live-data.polymarket.com");
    ws.onopen = () => {
      this.lastMessage = Date.now(); this.retries = 0; this.status = "Chainlink RTDS connected";
      ws.send(JSON.stringify({ action: "subscribe", subscriptions: Object.keys(topics).map(topic => ({ topic, type: topic === "crypto_prices_chainlink" ? "*" : "update", filters: JSON.stringify({ symbol: "btc/usd" }) })) }));
      this.heartbeat = setInterval(() => {
        if (Date.now() - this.lastMessage > 20000) { ws.close(); return; }
        if (ws.readyState === WebSocket.OPEN) ws.send("PING");
      }, 5000);
    };
    ws.onmessage = e => {
      this.lastMessage = Date.now();
      try { this.ingest(JSON.parse(String(e.data))); } catch { /* RTDS also sends PONG. */ }
    };
    ws.onerror = () => { this.status = "Chainlink RTDS connection error"; ws.close(); };
    ws.onclose = () => {
      clearInterval(this.heartbeat); this.status = "Chainlink RTDS disconnected, reconnecting";
      if (!this.stopped) this.reconnect = setTimeout(() => this.connect(), Math.min(30000, 1000 * 2 ** Math.min(this.retries++, 5)));
    };
  }
}

export class PolymarketData implements MarketData {
  readonly feed = new ReferenceFeed();
  readonly perpFeed: PerpFeed | null;
  private market?: Market;
  private marketLoadedAt = 0;
  constructor(private options: { perp: boolean; maxDataAgeMs: number } = { perp: true, maxDataAgeMs: 15000 }) {
    this.perpFeed = options.perp ? new PerpFeed() : null;
  }
  start() { this.feed.start(); this.perpFeed?.start(); }
  stop() { this.feed.stop(); this.perpFeed?.stop(); }
  status() { return this.perpFeed ? `${this.feed.status} · ${this.perpFeed.status}` : this.feed.status; }
  async snapshot(now = Date.now()): Promise<Snapshot> {
    const slug = `btc-updown-5m-${Math.floor(now / 300000) * 300}`;
    if (this.market?.slug !== slug || now - this.marketLoadedAt > 15000) {
      const event = await getJson(`https://gamma-api.polymarket.com/events/slug/${slug}`);
      const m = parseMarket(event, slug);
      if (!m.fee) {
        const info = object.parse(await getJson(`https://clob.polymarket.com/clob-markets/${m.conditionId}`));
        const fd = object.safeParse(info.fd);
        if (fd.success) m.fee = parseFee({ rate: fd.data.r, exponent: fd.data.e });
      }
      if (!m.anchor && this.market?.slug === slug) m.anchor = this.market.anchor;
      this.market = m; this.marketLoadedAt = now;
    }
    const m = this.market;
    const history = this.feed.ticks.filter(t => t.source === m.source && t.timestamp >= now - 300000);
    if (!m.anchor) {
      const boundary = history.find(t => t.timestamp === m.startMs);
      if (boundary) m.anchor = { price: boundary.price, source: "rtds-exact-boundary" };
    }
    const rawBooks = await getJson("https://clob.polymarket.com/books", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify([{ token_id: m.tokens.up }, { token_id: m.tokens.down }]),
    });
    const books = z.array(object).parse(rawBooks), received = Date.now();
    const chainlinkSpot = this.feed.ticks.filter(t => t.source === "chainlink-spot").at(-1) ?? null;
    return { at: received, market: structuredClone(m), history,
      reference: history.at(-1) ?? null,
      perp: this.perpFeed?.features(received, this.options.maxDataAgeMs, { chainlinkSpot, windowStartMs: m.startMs }) ?? null,
      books: { up: parseBook(books.find(b => b.asset_id === m.tokens.up), m.tokens.up, received), down: parseBook(books.find(b => b.asset_id === m.tokens.down), m.tokens.down, received) },
    };
  }
  async resolve(conditionId: string): Promise<Resolution | null> {
    return parseResolution(await getJson(`https://data-api.polymarket.com/v2/resolutions?condition=${encodeURIComponent(conditionId)}`), conditionId);
  }
}
