/** Fixed start-to-start cadence. Missed slots are skipped, never queued. */
export function nextCycleAt(startedAt: number, finishedAt: number, intervalMs: number, failures = 0): number {
  if (failures > 0) return finishedAt + Math.min(60000, intervalMs * 2 ** Math.min(failures, 4));
  const slots = Math.max(1, Math.ceil(Math.max(0, finishedAt - startedAt) / intervalMs));
  return startedAt + slots * intervalMs;
}

export const ROUND_MS = 300000;
/** Interval by time elapsed in the 5-minute round: [endSecond, intervalMs] pairs, ascending. */
export type PollSchedule = [number, number][];
export const DEFAULT_POLL_SCHEDULE = "300:6000";

export function parsePollSchedule(value: string): PollSchedule {
  const steps = value.split(",").map(part => {
    const [end, ms] = part.split(":").map(Number);
    if (!Number.isFinite(end) || !Number.isFinite(ms) || end! <= 0 || end! > 300 || ms! < 1000 || ms! > 60000) throw new Error("Invalid POLL_SCHEDULE: expected e.g. 120:2000,240:4000,300:7000");
    return [end!, ms!] as [number, number];
  });
  if (steps.some((s, i) => i > 0 && s[0] <= steps[i - 1]![0]) || steps.at(-1)![0] !== 300) throw new Error("POLL_SCHEDULE seconds must ascend and end at 300");
  return steps;
}
export function pollIntervalAt(at: number, schedule: PollSchedule): number {
  const second = (at % ROUND_MS) / 1000;
  return schedule.find(([end]) => second < end)?.[1] ?? schedule.at(-1)![1];
}
/** Never schedule past the next round's opening, so each round starts at its fast cadence. */
export function clampToRound(startedAt: number, next: number): number {
  return Math.min(next, (Math.floor(startedAt / ROUND_MS) + 1) * ROUND_MS);
}
