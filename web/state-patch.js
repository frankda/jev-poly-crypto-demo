// Applies a patch produced by src/state-patch.ts to the last full dashboard state.
export function applyPatch(state, patch) {
  const next = { ...state, ...patch.set };
  if (!patch.set?.snapshot && next.snapshot) {
    let snapshot = next.snapshot;
    if (patch.snap) snapshot = { ...snapshot, ...patch.snap };
    if (patch.history) snapshot = { ...snapshot, history: snapshot.history.slice(0, patch.history.from).concat(patch.history.items) };
    next.snapshot = snapshot;
  }
  if (patch.points) next.decisionPoints = next.decisionPoints.slice(0, patch.points.from).concat(patch.points.items);
  if (patch.events) next.events = patch.events.head.concat(next.events.slice(0, patch.events.keep));
  return next;
}
