import type { publicView } from "./public-view";

type View = ReturnType<typeof publicView>;
type Json = unknown;
export type ListPatch = { from: number; items: Json[] };
export type HeadPatch = { head: Json[]; keep: number };
export interface StatePatch {
  set?: Record<string, Json>;
  snap?: Record<string, Json>;
  history?: ListPatch;
  points?: ListPatch;
  events?: HeadPatch;
}

const key = (v: Json) => JSON.stringify(v);

/** Replace-from-index patch for lists that grow or change at the tail. */
export function tailPatch(prev: Json[], next: Json[]): ListPatch | null {
  let i = 0;
  while (i < prev.length && i < next.length && key(prev[i]) === key(next[i])) i++;
  return i === prev.length && i === next.length ? null : { from: i, items: next.slice(i) };
}

/** Prepend patch for newest-first lists (new entries at the head, oldest dropped). */
export function headPatch(prev: Json[], next: Json[]): HeadPatch | null {
  const p = prev.map(key), n = next.map(key);
  for (let k = 0; k <= n.length; k++) {
    const keep = n.length - k;
    if (keep <= p.length && n.slice(k).every((v, i) => v === p[i])) return k === 0 && keep === p.length ? null : { head: next.slice(0, k), keep };
  }
  return { head: next, keep: 0 };
}

/** Changes from prev to next; null means send the full state instead. Reapplied by web/state-patch.js. */
export function diffView(prev: View | null, next: View): StatePatch | null {
  if (!prev) return null;
  const patch: StatePatch = {}, set: Record<string, Json> = {};
  for (const k of Object.keys(next) as (keyof View)[]) {
    if (k === "snapshot" || k === "decisionPoints" || k === "events") continue;
    if (key(prev[k]) !== key(next[k])) set[k] = next[k];
  }
  const ps = prev.snapshot, ns = next.snapshot;
  if (!ps || !ns || ps.market.slug !== ns.market.slug) { if (key(ps) !== key(ns)) set.snapshot = ns; }
  else {
    const snap: Record<string, Json> = {};
    for (const k of Object.keys(ns) as (keyof typeof ns)[]) if (k !== "history" && key(ps[k]) !== key(ns[k])) snap[k] = ns[k];
    if (Object.keys(snap).length) patch.snap = snap;
    const history = tailPatch(ps.history, ns.history);
    if (history) patch.history = history;
  }
  const points = tailPatch(prev.decisionPoints, next.decisionPoints);
  if (points) patch.points = points;
  const events = headPatch(prev.events, next.events);
  if (events) patch.events = events;
  if (Object.keys(set).length) patch.set = set;
  return patch;
}
