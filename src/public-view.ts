import type { Engine } from "./engine";

type View = ReturnType<Engine["view"]>;
const HISTORY_POINTS = 150;
const rawOnly = (d: { rawScores: unknown } | null | undefined) => (d ? { rawScores: d.rawScores } : null);

/** The dashboard payload: only fields the page renders. Keeps SSE bandwidth low with many viewers. */
export function publicView(v: View) {
  const s = v.snapshot;
  const top = (b: { bids: unknown[]; asks: unknown[] }) => ({ bids: b.bids.slice(0, 1), asks: b.asks.slice(0, 1) });
  let history = s ? s.history.filter(t => t.timestamp >= s.market.startMs) : [];
  if (history.length > HISTORY_POINTS) {
    const step = history.length / HISTORY_POINTS, last = history.at(-1)!;
    history = Array.from({ length: HISTORY_POINTS - 1 }, (_, i) => history[Math.floor(i * step)]!).concat(last);
  }
  return {
    ...v,
    snapshot: s && {
      at: s.at, reference: s.reference, perp: s.perp, history,
      market: { slug: s.market.slug, startMs: s.market.startMs, endMs: s.market.endMs, source: s.market.source, anchor: s.market.anchor },
      books: { up: top(s.books.up), down: top(s.books.down) },
    },
    decisionPoints: v.decisionPoints.map(p => ({ id: p.id, slug: p.slug, at: p.at, referenceAt: p.referenceAt, price: p.price, direction: p.direction, action: p.action, decision: rawOnly(p.decision) })),
    events: v.events.map(e => ({ ...e, decision: rawOnly(e.decision) })),
    trades: v.trades.slice(0, 12),
  };
}
