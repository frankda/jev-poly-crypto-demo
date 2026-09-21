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
