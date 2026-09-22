import { expect, test } from 'bun:test';
import { directionOf, shouldPulse } from '../web/decision-view.js';

test('Up, Down and tied scores have distinct display directions', () => {
  expect(directionOf({ rawScores: { up: .8, down: .2 } })).toBe('up');
  expect(directionOf({ rawScores: { up: .2, down: .8 } })).toBe('down');
  expect(directionOf({ rawScores: { up: .5, down: .5 } })).toBe('neutral');
  expect(directionOf(null)).toBeNull();
});
test('new inference pulses once; identical SSE heartbeat and replayed history do not pulse', () => {
  const p = { id: 42, at: 10000 };
  expect(shouldPulse(p, 41, true, 10100)).toBe(true);
  expect(shouldPulse(p, 42, true, 10100)).toBe(false);
  expect(shouldPulse(p, null, false, 10100)).toBe(false);
  expect(shouldPulse(p, 41, true, 16000)).toBe(false);
  expect(shouldPulse(p, 41, true, 9000)).toBe(false);
  expect(shouldPulse(null, 41, true, 10100)).toBe(false);
});
