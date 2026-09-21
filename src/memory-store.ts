import type { Account, Decision, DecisionPoint, ExitQuote, Ledger, Quote, Resolution, Signal, Snapshot, Trade } from "./types";

interface LedgerEvent { id: number; at: number; kind: string; data: any }

/** In-memory paper ledger for hosted demos (LEDGER=memory). Nothing is written to disk; a restart starts from a fresh bankroll. */
export class MemoryStore implements Ledger {
  private tradeRows: Trade[] = [];
  private events: LedgerEvent[] = [];
  private nextTradeId = 1;
  private nextEventId = 1;
  constructor(readonly bankroll: number, private maxEvents = 2000) {}
  close() {}
  trades(limit = 100): Trade[] { return this.tradeRows.slice(-limit).reverse().map(t => structuredClone(t)); }
  openTrades(): Trade[] { return this.tradeRows.filter(t => t.settledAt === null).map(t => structuredClone(t)); }
  openTrade(conditionId: string): Trade | null {
    const t = this.tradeRows.find(t => t.conditionId === conditionId && t.settledAt === null);
    return t ? structuredClone(t) : null;
  }
  hasOpenTrade(conditionId: string): boolean { return this.tradeRows.some(t => t.conditionId === conditionId && t.settledAt === null); }
  account(now = Date.now()): Account {
    const dayStart = Math.floor(now / 86400000) * 86400000;
    const open = this.tradeRows.filter(t => t.settledAt === null), settled = this.tradeRows.filter(t => t.settledAt !== null);
    const realizedPnl = settled.reduce((sum, t) => sum + (t.pnl ?? 0), 0);
    const exposure = open.reduce((sum, t) => sum + t.total, 0);
    return { bankroll: this.bankroll, cash: this.bankroll + realizedPnl - exposure, exposure, realizedPnl,
      dailyPnl: settled.filter(t => t.settledAt! >= dayStart).reduce((sum, t) => sum + (t.pnl ?? 0), 0),
      openTrades: open.length, settledTrades: settled.length, wins: settled.filter(t => (t.pnl ?? 0) > 0).length };
  }
  record(at: number, kind: string, data: unknown) {
    const id = this.nextEventId++;
    // Deep copy so later mutations of live objects don't rewrite history.
    this.events.push({ id, at, kind, data: structuredClone(data) });
    if (this.events.length > this.maxEvents) this.events.splice(0, this.events.length - this.maxEvents);
    return id;
  }
  recentDecisionPoints(limit = 180): DecisionPoint[] {
    return this.events.filter(e => e.kind === "decision" && e.data?.point).slice(-limit).map(e => e.data.point);
  }
  recentEvents(limit = 60) { return this.events.slice(-limit).reverse(); }
  lastEvaluation(): { slug: string; decision: Decision } | null {
    for (let i = this.events.length - 1; i >= 0; i--) {
      const e = this.events[i]!;
      if (e.kind === "decision" && e.data?.decision) return { slug: e.data.market.slug, decision: e.data.decision };
    }
    return null;
  }
  open(snapshot: Snapshot, quote: Quote, decision: Decision, now = Date.now()): boolean {
    if (this.hasOpenTrade(snapshot.market.conditionId) || this.account(now).cash + 1e-8 < quote.total) return false;
    const trade: Trade = { ...quote, id: this.nextTradeId++, conditionId: snapshot.market.conditionId, slug: snapshot.market.slug,
      outcomeIndex: snapshot.market.outcomeIndices[quote.side], openedAt: now, endMs: snapshot.market.endMs, settledAt: null, payout: null, pnl: null };
    this.tradeRows.push(trade);
    this.record(now, "paper-fill", { trade, decision });
    return true;
  }
  sell(exit: ExitQuote, decision: Decision, now = Date.now()): boolean {
    const trade = this.tradeRows.find(t => t.id === exit.tradeId && t.settledAt === null);
    if (!trade || trade.side !== exit.side || Math.abs(trade.shares - exit.shares) > 1e-9) return false;
    const { tradeId: _, ...fill } = exit;
    trade.exit = { ...fill, at: now };
    trade.payout = exit.proceeds;
    trade.pnl = exit.proceeds - trade.total;
    trade.settledAt = now;
    this.record(now, "paper-exit", { tradeId: exit.tradeId, exit, decision, pnl: trade.pnl });
    return true;
  }
  settle(tradeId: number, resolution: Resolution, now = Date.now()): boolean {
    const trade = this.tradeRows.find(t => t.id === tradeId && t.settledAt === null);
    if (!trade || now < trade.endMs) return false;
    const payoutRate = resolution.payouts[trade.outcomeIndex];
    if (payoutRate === undefined || !Number.isFinite(payoutRate) || payoutRate < 0 || payoutRate > 1) throw new Error("Invalid official payout");
    trade.payout = trade.shares * payoutRate;
    trade.pnl = trade.payout - trade.total;
    trade.settledAt = now;
    this.record(now, "settlement", { tradeId, source: resolution.source, payout: trade.payout, pnl: trade.pnl });
    return true;
  }
  recordDecision(snapshot: Snapshot, decision: Decision | null, signal: Signal, point: DecisionPoint | null = null) {
    this.record(Date.now(), "decision", { market: { slug: snapshot.market.slug }, decision, signal, point });
  }
}
