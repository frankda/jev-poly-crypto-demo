import { z } from "zod";
import type { PerpFeatures, Tick } from "./types";

/** Binance USDⓈ-M BTCUSDT perpetual as an auxiliary signal only.
 * It is never the settlement reference: Polymarket settles on the Chainlink stream in market.source. */
const DEPTH_URL = "wss://fstream.binance.com/public/stream?streams=btcusdt@depth20@100ms";
const TRADE_URL = "wss://fstream.binance.com/market/stream?streams=btcusdt@aggTrade";
const WINDOW_MS = 300000;

const num = z.union([z.number(), z.string().min(1)]).transform(Number).pipe(z.number().finite().positive());
const level = z.tuple([num, num]);
const depthMsg = z.object({ e: z.literal("depthUpdate"), s: z.literal("BTCUSDT"), E: num, b: z.array(level).min(1), a: z.array(level).min(1) });
const tradeMsg = z.object({ e: z.literal("aggTrade"), s: z.literal("BTCUSDT"), T: num, p: num, q: num, m: z.boolean() });

interface Depth { at: number; receivedAt: number; bids: [number, number][]; asks: [number, number][] }
interface Trade { at: number; qty: number; buy: boolean }

const imbalance = (a: number, b: number) => a + b > 0 ? (a - b) / (a + b) : null;
const sum = (levels: [number, number][], n: number) => levels.slice(0, n).reduce((s, [, q]) => s + q, 0);

export class PerpFeed {
  depth: Depth | null = null;
  trades: Trade[] = [];
  mids: { at: number; price: number }[] = [];
  /** Start of uninterrupted trade coverage; flow windows longer than this are unknown, not small. */
  tradesSince: number | null = null;
  status = "等待连接 Binance 合约";
  private sockets = new Map<string, { ws?: WebSocket; retries: number; timer?: ReturnType<typeof setTimeout>; last: number }>();
  private watchdog?: ReturnType<typeof setInterval>;
  private stopped = true;

  ingest(value: unknown, now = Date.now()) {
    const msg = z.object({ data: z.unknown() }).safeParse(value);
    if (!msg.success) return;
    const d = depthMsg.safeParse(msg.data.data);
    if (d.success) {
      const bids = d.data.b.sort((x, y) => y[0] - x[0]), asks = d.data.a.sort((x, y) => x[0] - y[0]);
      if (bids[0]![0] >= asks[0]![0] || d.data.E > now + 2000) return;
      this.depth = { at: d.data.E, receivedAt: now, bids, asks };
      this.mids.push({ at: d.data.E, price: (bids[0]![0] + asks[0]![0]) / 2 });
    }
    const t = tradeMsg.safeParse(msg.data.data);
    // m=true: buyer is maker, so the aggressor sold.
    if (t.success && t.data.T <= now + 2000) { this.tradesSince ??= now; this.trades.push({ at: t.data.T, qty: t.data.q, buy: !t.data.m }); }
    this.mids = this.mids.filter(p => p.at >= now - WINDOW_MS);
    this.trades = this.trades.filter(p => p.at >= now - 60000);
  }

  /** Returns null when the book is missing or stale; perp data must never be passed off as fresh. */
  features(now: number, maxAgeMs: number, reference: { chainlinkSpot: Tick | null; windowStartMs: number }): PerpFeatures | null {
    const d = this.depth;
    if (!d || now - d.at > maxAgeMs || d.at - now > 2000) return null;
    const [bid, bidQty] = d.bids[0]!, [ask, askQty] = d.asks[0]!;
    const mid = (bid + ask) / 2;
    const micro = (bid * askQty + ask * bidQty) / (bidQty + askQty);
    const midAt = (t: number) => this.mids.filter(p => p.at <= t).at(-1)?.price ?? null;
    const ret = (seconds: number) => { const past = midAt(now - seconds * 1000); return past ? (mid / past - 1) * 1e4 : null; };
    const flow = (seconds: number) => {
      if (this.tradesSince === null || this.tradesSince > now - seconds * 1000) return null;
      const recent = this.trades.filter(t => t.at >= now - seconds * 1000 && t.at <= now);
      const buy = recent.filter(t => t.buy).reduce((s, t) => s + t.qty, 0), sell = recent.filter(t => !t.buy).reduce((s, t) => s + t.qty, 0);
      return { buyBtc: buy, sellBtc: sell, imbalance: imbalance(buy, sell) };
    };
    const spot = reference.chainlinkSpot;
    const startMid = this.mids.find(p => p.at >= reference.windowStartMs && p.at <= reference.windowStartMs + 5000)?.price ?? null;
    return {
      source: "binance-usdm-btcusdt-perp", at: d.at, mid, spreadBps: (ask - bid) / mid * 1e4,
      micropriceOffsetBps: (micro / mid - 1) * 1e4,
      depthImbalance: { top5: imbalance(sum(d.bids, 5), sum(d.asks, 5)), top20: imbalance(sum(d.bids, 20), sum(d.asks, 20)) },
      takerFlow: { seconds10: flow(10), seconds30: flow(30), seconds60: flow(60) },
      returnsBps: { seconds10: ret(10), seconds30: ret(30), seconds60: ret(60) },
      sinceWindowStartBps: startMid ? (mid / startMid - 1) * 1e4 : null,
      basisVsChainlinkSpotBps: spot && Math.abs(now - spot.timestamp) <= maxAgeMs ? (mid / spot.price - 1) * 1e4 : null,
    };
  }

  start() {
    this.stopped = false;
    for (const url of [DEPTH_URL, TRADE_URL]) { this.sockets.set(url, { retries: 0, last: 0 }); this.connect(url); }
    this.watchdog = setInterval(() => {
      for (const s of this.sockets.values()) if (s.ws?.readyState === WebSocket.OPEN && Date.now() - s.last > 20000) s.ws.close();
    }, 5000);
  }
  stop() {
    this.stopped = true; clearInterval(this.watchdog);
    for (const s of this.sockets.values()) { clearTimeout(s.timer); s.ws?.close(); }
  }
  private refreshStatus() {
    const open = [...this.sockets.values()].filter(s => s.ws?.readyState === WebSocket.OPEN).length;
    this.status = open === this.sockets.size ? "Binance 合约已连接" : open ? "Binance 合约部分连接" : "Binance 合约已断开，等待重连";
  }
  private connect(url: string) {
    const s = this.sockets.get(url);
    if (this.stopped || !s) return;
    const ws = s.ws = new WebSocket(url);
    ws.onopen = () => { s.retries = 0; s.last = Date.now(); this.refreshStatus(); };
    // Binance sends protocol-level pings; the runtime answers them automatically.
    ws.onmessage = e => { s.last = Date.now(); try { this.ingest(JSON.parse(String(e.data))); } catch { /* ignore malformed frames */ } };
    ws.onerror = () => ws.close();
    ws.onclose = () => {
      if (url === TRADE_URL) this.tradesSince = null;
      this.refreshStatus();
      if (!this.stopped) s.timer = setTimeout(() => this.connect(url), Math.min(30000, 1000 * 2 ** Math.min(s.retries++, 5)));
    };
  }
}
