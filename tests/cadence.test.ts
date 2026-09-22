import { expect, test } from "bun:test";
import { nextCycleAt } from "../src/cadence";

test("two-second cadence subtracts work time instead of adding two seconds after completion", () => {
  expect(nextCycleAt(10000, 11400, 2000)).toBe(12000);
  expect(nextCycleAt(12000, 12700, 2000)).toBe(14000);
  expect(nextCycleAt(10000, 12000, 2000)).toBe(12000);
});
test("slow requests skip missed slots without a catch-up burst", () => {
  expect(nextCycleAt(10000, 12500, 2000)).toBe(14000);
  expect(nextCycleAt(10000, 20500, 2000)).toBe(22000);
});
test("errors back off from completion and retain the one-minute ceiling", () => {
  expect(nextCycleAt(10000, 11000, 2000, 1)).toBe(15000);
  expect(nextCycleAt(10000, 11000, 5000, 20)).toBe(71000);
});
import { clampToRound, parsePollSchedule, pollIntervalAt, DEFAULT_POLL_SCHEDULE } from "../src/cadence";
import { readConfig } from "../src/config";

test("default schedule: 2s for the first two minutes, 4s until 4:00, 7s in the last minute", () => {
  const s = parsePollSchedule(DEFAULT_POLL_SCHEDULE), round = 1800000000000 - (1800000000000 % 300000);
  expect(pollIntervalAt(round, s)).toBe(2000);
  expect(pollIntervalAt(round + 119999, s)).toBe(2000);
  expect(pollIntervalAt(round + 120000, s)).toBe(4000);
  expect(pollIntervalAt(round + 239999, s)).toBe(4000);
  expect(pollIntervalAt(round + 240000, s)).toBe(7000);
  expect(pollIntervalAt(round + 299999, s)).toBe(7000);
  expect(pollIntervalAt(round + 300000, s)).toBe(2000);
});
test("a slow last-minute tick never spills past the next round's opening", () => {
  const round = 1800000000000 - (1800000000000 % 300000);
  expect(clampToRound(round + 296000, round + 303000)).toBe(round + 300000);
  expect(clampToRound(round + 10000, round + 12000)).toBe(round + 12000);
});
test("POLL_SCHEDULE validates input and 'fixed' restores constant POLL_MS", () => {
  for (const bad of ["120:2000", "120:2000,100:4000,300:7000", "120:500,300:7000", "abc"]) expect(() => parsePollSchedule(bad)).toThrow();
  expect(readConfig({ DATA_MODE: "demo" }).pollSchedule).toEqual([[120, 2000], [240, 4000], [300, 7000]]);
  expect(readConfig({ DATA_MODE: "demo", POLL_SCHEDULE: "fixed" }).pollSchedule).toBeNull();
});
