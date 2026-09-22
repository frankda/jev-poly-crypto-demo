import type { Engine } from "./engine";

type View = ReturnType<Engine["view"]>;
// One tick per 2 s bucket plus the latest tick: at most ~150 points, and only the tail ever changes (patchable).
const BUCKET_MS = 2000;
const rawOnly = (d: { rawScores: unknown } | null | undefined) => (d ? { rawScores: d.rawScores } : null);

/** The dashboard payload: only fields the page renders. Keeps SSE bandwidth low with many viewers. */
export function publicView(v: View) {
  const s = v.snapshot;
  const top = (b: { bids: unknown[]; asks: unknown[] }) => ({ bids: b.bids.slice(0, 1), asks: b.asks.slice(0, 1) });
  const history: NonNullable<View["snapshot"]>["history"] = [];
  let bucket = -1;
  for (const t of s ? s.history : []) {
    if (t.timestamp < s!.market.startMs) continue;
    const b = Math.floor(t.timestamp / BUCKET_MS);
    if (b !== bucket) { history.push(t); bucket = b; }
  }
  const last = s?.history.at(-1);
  if (last && last.timestamp >= s!.market.startMs && history.at(-1) !== last) history.push(last);
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
