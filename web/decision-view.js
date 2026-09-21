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
