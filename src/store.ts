import { Database } from "bun:sqlite";
import type { Account, Decision, DecisionPoint, ExitQuote, Ledger, Quote, Resolution, Signal, Snapshot, Trade } from "./types";

/** Events that make up the trade state; always persisted. */
export const TRADE_EVENT_KINDS = new Set(["paper-fill", "paper-exit", "settlement", "control"]);
type StoredEvent = { id: number; at: number; kind: string; data: any };

export class Store implements Ledger {
  readonly db: Database;
  // LEDGER_EVENTS=trades: per-decision audit events stay in this bounded memory ring instead of on disk.
  private ring: StoredEvent[] = [];
  private lastId: number;
  constructor(path: string, readonly bankroll: number, private persistAll = true, private ringSize = 2000) {
    this.db = new Database(path, { create: true, strict: true });
    this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000;
      CREATE TABLE IF NOT EXISTS meta(key TEXT PRIMARY KEY, value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS trades(id INTEGER PRIMARY KEY, condition_id TEXT NOT NULL, opened_at INTEGER NOT NULL, settled_at INTEGER, data TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS events(id INTEGER PRIMARY KEY, at INTEGER NOT NULL, kind TEXT NOT NULL, data TEXT NOT NULL);`);
    // Older ledgers allowed one trade per round (UNIQUE condition_id). Re-entry after a sell needs that dropped.
    const schema = this.db.query<{ sql: string }, []>("SELECT sql FROM sqlite_master WHERE type='table' AND name='trades'").get();
    if (schema?.sql.includes("UNIQUE")) this.db.transaction(() => this.db.exec(`
      CREATE TABLE trades_v2(id INTEGER PRIMARY KEY, condition_id TEXT NOT NULL, opened_at INTEGER NOT NULL, settled_at INTEGER, data TEXT NOT NULL);
      INSERT INTO trades_v2(id, condition_id, opened_at, settled_at, data) SELECT id, condition_id, opened_at, settled_at, data FROM trades;
      DROP TABLE trades; ALTER TABLE trades_v2 RENAME TO trades;`))();
    this.db.exec("CREATE INDEX IF NOT EXISTS trades_condition ON trades(condition_id, settled_at)");
    this.db.query("INSERT OR IGNORE INTO meta VALUES ('bankroll', ?)").run(String(bankroll));
    const existing = this.db.query<{ value: string }, []>("SELECT value FROM meta WHERE key='bankroll'").get();
    if (Number(existing?.value) !== bankroll) throw new Error("BANKROLL_USD differs from the saved ledger; use a new DATA_DIR for a new experiment");
    const diskMax = this.db.query<{ id: number | null }, []>("SELECT max(id) AS id FROM events").get()?.id ?? 0;
    // Memory-only ids from a previous run are gone; starting at the clock (at µs resolution: far more headroom than events need)
    // keeps ids increasing across restarts so the dashboard never mistakes a new event for an old one.
    this.lastId = persistAll ? diskMax : Math.max(diskMax, Date.now() * 1000);
  }
  close() { this.db.close(); }
  trades(limit = 100): Trade[] {
    return this.db.query<{ id: number; data: string }, [number]>("SELECT id, data FROM trades ORDER BY id DESC LIMIT ?").all(limit).map(r => ({ ...JSON.parse(r.data), id: r.id }));
  }
  openTrades(): Trade[] {
    return this.db.query<{ id: number; data: string }, []>("SELECT id, data FROM trades WHERE settled_at IS NULL").all().map(r => ({ ...JSON.parse(r.data), id: r.id }));
  }
  openTrade(conditionId: string): Trade | null {
    const row = this.db.query<{ id: number; data: string }, [string]>("SELECT id, data FROM trades WHERE condition_id=? AND settled_at IS NULL").get(conditionId);
    return row ? { ...JSON.parse(row.data), id: row.id } : null;
  }
  hasOpenTrade(conditionId: string): boolean { return Boolean(this.db.query("SELECT 1 FROM trades WHERE condition_id=? AND settled_at IS NULL").get(conditionId)); }
  account(now = Date.now()): Account {
    const dayStart = Math.floor(now / 86400000) * 86400000;
    const rows = this.db.query<{ data: string }, []>("SELECT data FROM trades").all().map(r => JSON.parse(r.data) as Trade);
    const open = rows.filter(t => t.settledAt === null), settled = rows.filter(t => t.settledAt !== null);
    const realizedPnl = settled.reduce((sum, t) => sum + (t.pnl ?? 0), 0);
    const exposure = open.reduce((sum, t) => sum + t.total, 0);
    return { bankroll: this.bankroll, cash: this.bankroll + realizedPnl - exposure, exposure, realizedPnl,
      dailyPnl: settled.filter(t => t.settledAt! >= dayStart).reduce((sum, t) => sum + (t.pnl ?? 0), 0),
      openTrades: open.length, settledTrades: settled.length, wins: settled.filter(t => (t.pnl ?? 0) > 0).length };
  }
  record(at: number, kind: string, data: unknown) {
    // One id sequence across disk and memory keeps the dashboard's event ordering consistent.
    const id = ++this.lastId;
    if (this.persistAll || TRADE_EVENT_KINDS.has(kind)) this.db.query("INSERT INTO events(id,at,kind,data) VALUES(?,?,?,?)").run(id, at, kind, JSON.stringify(data));
    else {
      this.ring.push({ id, at, kind, data: structuredClone(data) });
      if (this.ring.length > this.ringSize) this.ring.splice(0, this.ring.length - this.ringSize);
    }
    return id;
  }
  recentDecisionPoints(limit = 180): DecisionPoint[] {
    if (!this.persistAll) return this.ring.filter(e => e.kind === "decision" && e.data?.point).slice(-limit).map(e => e.data.point);
    return this.db.query<{ data: string }, [number]>("SELECT data FROM events WHERE kind='decision' AND json_extract(data,'$.point') IS NOT NULL ORDER BY id DESC LIMIT ?")
      .all(limit).map(row => (JSON.parse(row.data) as { point: DecisionPoint }).point).reverse();
  }
  recentEvents(limit = 60): StoredEvent[] {
    const disk = this.db.query<{ id: number; at: number; kind: string; data: string }, [number]>("SELECT * FROM events ORDER BY id DESC LIMIT ?").all(limit).map(r => ({ ...r, data: JSON.parse(r.data) }));
    if (this.persistAll) return disk;
    return [...disk, ...this.ring.slice(-limit)].sort((a, b) => b.id - a.id).slice(0, limit);
  }
  lastEvaluation(): { slug: string; decision: Decision } | null {
    if (!this.persistAll) {
      for (let i = this.ring.length - 1; i >= 0; i--) {
        const e = this.ring[i]!;
        if (e.kind === "decision" && e.data?.decision) return { slug: e.data.market.slug, decision: e.data.decision };
      }
      return null;
    }
    const row = this.db.query<{ data: string }, []>("SELECT data FROM events WHERE kind='decision' AND json_extract(data,'$.decision') IS NOT NULL ORDER BY id DESC LIMIT 1").get();
    if (!row) return null;
    const data = JSON.parse(row.data) as { market: { slug: string }; decision: Decision };
    return { slug: data.market.slug, decision: data.decision };
  }
  open(snapshot: Snapshot, quote: Quote, decision: Decision, now = Date.now()): boolean {
    return this.db.transaction(() => {
      if (this.hasOpenTrade(snapshot.market.conditionId) || this.account(now).cash + 1e-8 < quote.total) return false;
      const trade: Omit<Trade, "id"> = { ...quote, conditionId: snapshot.market.conditionId, slug: snapshot.market.slug,
        outcomeIndex: snapshot.market.outcomeIndices[quote.side], openedAt: now, endMs: snapshot.market.endMs, settledAt: null, payout: null, pnl: null };
      this.db.query("INSERT INTO trades(condition_id,opened_at,data) VALUES(?,?,?)").run(trade.conditionId, now, JSON.stringify(trade));
      this.record(now, "paper-fill", { trade, decision });
      return true;
    })();
  }
  sell(exit: ExitQuote, decision: Decision, now = Date.now()): boolean {
    return this.db.transaction(() => {
      const row = this.db.query<{ data: string }, [number]>("SELECT data FROM trades WHERE id=? AND settled_at IS NULL").get(exit.tradeId);
      if (!row) return false;
      const trade = JSON.parse(row.data) as Trade;
      if (trade.side !== exit.side || Math.abs(trade.shares - exit.shares) > 1e-9) return false;
      const { tradeId: _, ...fill } = exit;
      trade.exit = { ...fill, at: now };
      trade.payout = exit.proceeds;
      trade.pnl = exit.proceeds - trade.total;
      trade.settledAt = now;
      this.db.query("UPDATE trades SET settled_at=?,data=? WHERE id=?").run(now, JSON.stringify(trade), exit.tradeId);
      this.record(now, "paper-exit", { tradeId: exit.tradeId, exit, decision, pnl: trade.pnl });
      return true;
    })();
  }
  settle(tradeId: number, resolution: Resolution, now = Date.now()): boolean {
    return this.db.transaction(() => {
      const row = this.db.query<{ data: string }, [number]>("SELECT data FROM trades WHERE id=? AND settled_at IS NULL").get(tradeId);
      if (!row) return false;
      const trade = JSON.parse(row.data) as Trade;
      if (now < trade.endMs) return false;
      const payoutRate = resolution.payouts[trade.outcomeIndex];
      if (payoutRate === undefined || !Number.isFinite(payoutRate) || payoutRate < 0 || payoutRate > 1) throw new Error("Invalid official payout");
      trade.payout = trade.shares * payoutRate;
      trade.pnl = trade.payout - trade.total;
      trade.settledAt = now;
      this.db.query("UPDATE trades SET settled_at=?,data=? WHERE id=?").run(now, JSON.stringify(trade), tradeId);
      this.record(now, "settlement", { tradeId, source: resolution.source, payout: trade.payout, pnl: trade.pnl });
      return true;
    })();
  }
  recordDecision(snapshot: Snapshot, decision: Decision | null, signal: Signal, point: DecisionPoint | null = null) {
    // Persist compact raw inputs plus output; enough to audit why an entry was taken.
    this.record(Date.now(), "decision", { market: snapshot.market, reference: snapshot.reference, perp: snapshot.perp,
      books: snapshot.books, history: snapshot.history.filter((_, i) => i % Math.max(1, Math.ceil(snapshot.history.length / 30)) === 0), decision, signal, point });
  }
}
