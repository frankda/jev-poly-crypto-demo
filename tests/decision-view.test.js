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
import { nearestPoint, tooltipRows } from '../web/decision-view.js';

test('hover snaps to the nearest decision point and ignores far-away positions', () => {
  const points = [{ id: 1, referenceAt: 0 }, { id: 2, referenceAt: 100 }, { id: 3, referenceAt: 300 }];
  const x = t => t;
  expect(nearestPoint(points, x, 90)?.id).toBe(2);
  expect(nearestPoint(points, x, 260)?.id).toBe(3);
  expect(nearestPoint(points, x, 800)).toBeNull();
  expect(nearestPoint([], x, 10)).toBeNull();
});
test('tooltip shows Jev probabilities and Polymarket quotes; old points without quotes say so', () => {
  const point = { at: 0, price: 86432.1, direction: 'up', action: 'up',
    decision: { rawScores: { up: .87, down: .13 } },
    quotes: { up: { bid: .61, ask: .63 }, down: { bid: .37, ask: .39 } } };
  const rows = tooltipRows(point, 3, () => '10:11:18', n => `$${n}`);
  expect(rows[0][0]).toBe('10:11:18 · 第 4 次判断');
  expect(rows.find(r => r[0] === 'Jev UP / DOWN')[1]).toBe('87.0% / 13.0%');
  expect(rows.find(r => r[0] === 'Poly UP 买 / 卖')[1]).toBe('63.0¢ / 61.0¢');
  expect(rows.find(r => r[0] === 'Poly DOWN 买 / 卖')[1]).toBe('39.0¢ / 37.0¢');
  expect(rows.find(r => r[0] === '模拟动作')[1]).toBe('买入 UP');
  const old = tooltipRows({ ...point, quotes: undefined, action: 'wait' }, 0, () => 't', n => n);
  expect(old.find(r => r[0] === 'Poly UP 买 / 卖')[1]).toBe('未记录');
});
