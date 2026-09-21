/** Fixed start-to-start cadence. Missed slots are skipped, never queued. */
export function nextCycleAt(startedAt: number, finishedAt: number, intervalMs: number, failures = 0): number {
  if (failures > 0) return finishedAt + Math.min(60000, intervalMs * 2 ** Math.min(failures, 4));
  const slots = Math.max(1, Math.ceil(Math.max(0, finishedAt - startedAt) / intervalMs));
  return startedAt + slots * intervalMs;
}
