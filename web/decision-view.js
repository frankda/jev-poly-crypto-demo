export function directionOf(decision) {
  if (!decision) return null;
  if (decision.rawScores.up === decision.rawScores.down) return 'neutral';
  return decision.rawScores.up > decision.rawScores.down ? 'up' : 'down';
}

// Reconnects and SSE heartbeats must not manufacture a new inference animation.
export function shouldPulse(point, lastId, initialized, serverTime) {
  return Boolean(initialized && point && point.id !== lastId &&
    Number.isFinite(point.at) && serverTime - point.at >= 0 && serverTime - point.at < 5000);
}

/** Decision point nearest to chart x (viewBox units), or null when none is within maxDistance. */
export function nearestPoint(points, xOf, x, maxDistance = 40) {
  let best = null, bestDistance = Infinity;
  for (const p of points) {
    const d = Math.abs(xOf(p.referenceAt) - x);
    if (d < bestDistance) { best = p; bestDistance = d; }
  }
  return bestDistance <= maxDistance ? best : null;
}

const pct = n => Number.isFinite(n) ? `${(n * 100).toFixed(1)}%` : '—';
const cents = n => Number.isFinite(n) ? `${(n * 100).toFixed(1)}¢` : '—';
const actionLabel = { up: '买入 UP', down: '买入 DOWN', sell: '卖出', wait: '观望' };

/** Tooltip rows for one decision point: [label, value, tone]. */
export function tooltipRows(point, index, formatTime, formatUsd) {
  const q = point.quotes;
  return [
    [`${formatTime(point.at)} · 第 ${index + 1} 次判断`, '', 'title'],
    ['BTC 参考价', formatUsd(point.price), ''],
    ['Jev UP / DOWN', `${pct(point.decision.rawScores.up)} / ${pct(point.decision.rawScores.down)}`, point.direction],
    ['Poly UP 买 / 卖', q ? `${cents(q.up.ask)} / ${cents(q.up.bid)}` : '未记录', 'up'],
    ['Poly DOWN 买 / 卖', q ? `${cents(q.down.ask)} / ${cents(q.down.bid)}` : '未记录', 'down'],
    ['模拟动作', actionLabel[point.action] ?? point.action, ''],
  ];
}
