const $ = id => document.getElementById(id);
const usd = n => Number.isFinite(n) ? new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', minimumFractionDigits: 2 }).format(n) : '—';
const pct = n => Number.isFinite(n) ? `${(n * 100).toFixed(1)}%` : '—';
const cents = n => Number.isFinite(n) ? `${(n * 100).toFixed(1)}¢` : '—';
const time = t => new Date(t).toLocaleTimeString('en-GB', { hour12: false });
const set = (id, text) => { $(id).textContent = text; };
let state = null, lastReceived = 0, connected = false, initialized = false, lastPointId = null;
let activePulse = null, pulseTimer = null, flashTimer = null, lastRenderedEventId = null, lastTradeSignature = '';
const svgElement = (tag, attrs = {}) => {
  const element = document.createElementNS('http://www.w3.org/2000/svg', tag);
  for (const [key, value] of Object.entries(attrs)) element.setAttribute(key, value);
  return element;
};
function pulseDecision(point, previous) {
  activePulse = point;
  const group = $('decision-pulse'); group.dataset.direction = point.direction;
  group.dataset.evaluationId = String(point.id);
  group.dataset.pulseCount = String(Number(group.dataset.pulseCount ?? 0) + 1);
  group.replaceChildren(svgElement('circle', { r: 7, class: 'pulse-ring' }), svgElement('circle', { r: 7, class: 'pulse-ring delayed' }), svgElement('circle', { r: 5, class: 'pulse-core' }));
  const box = $('signal-box'); box.classList.remove('new-decision', 'direction-flip');
  void box.offsetWidth;
  box.classList.add('new-decision');
  if (previous && previous.direction !== point.direction) box.classList.add('direction-flip');
  clearTimeout(pulseTimer); clearTimeout(flashTimer);
  pulseTimer = setTimeout(() => { activePulse = null; group.replaceChildren(); }, 1600);
  flashTimer = setTimeout(() => box.classList.remove('new-decision', 'direction-flip'), 900);
}
function paintChart(snapshot, decisions = []) {
  const ticks = (snapshot?.history ?? []).filter(t => t.timestamp >= snapshot.market.startMs && Number.isFinite(t.price));
  const pointsOnChart = decisions.filter(p => p.slug === snapshot?.market.slug && p.referenceAt >= snapshot.market.startMs && p.referenceAt <= snapshot.market.endMs && Number.isFinite(p.price));
  const values = [...ticks.map(t => t.price), ...pointsOnChart.map(p => p.price)], anchor = snapshot?.market.anchor?.price;
  if (Number.isFinite(anchor)) values.push(anchor);
  $('chart-empty').style.display = ticks.length < 2 ? '' : 'none';
  for (const id of ['chart-path', 'chart-area']) $(id).setAttribute('d', '');
  $('anchor-line').style.display = 'none'; $('chart-dot').style.display = 'none';
  $('decision-dots').replaceChildren();
  if (activePulse?.slug !== snapshot?.market.slug) { activePulse = null; $('decision-pulse').replaceChildren(); }
  if (ticks.length < 2) return;
  const low = Math.min(...values), high = Math.max(...values), padding = Math.max((high - low) * .2, 5);
  const x = t => (t - snapshot.market.startMs) / 300000 * 850;
  const y = price => 205 - (price - low + padding) / (high - low + 2 * padding) * 190;
  const points = ticks.map(t => `${x(t.timestamp).toFixed(2)},${y(t.price).toFixed(2)}`);
  $('chart-path').setAttribute('d', `M${points.join(' L')}`);
  $('chart-area').setAttribute('d', `M${x(ticks[0].timestamp)},220 L${points.join(' L')} L${x(ticks.at(-1).timestamp)},220 Z`);
  $('chart-dot').style.display = ''; $('chart-dot').setAttribute('cx', x(ticks.at(-1).timestamp)); $('chart-dot').setAttribute('cy', y(ticks.at(-1).price));
  for (const point of pointsOnChart) {
    const dot = svgElement('circle', { cx: x(point.referenceAt), cy: y(point.price), r: point.id === decisions.at(-1)?.id ? 4 : 2.6, class: point.direction });
    const title = svgElement('title'); title.textContent = `${time(point.at)} · ${point.direction.toUpperCase()} · UP ${pct(point.decision.rawScores.up)} / DOWN ${pct(point.decision.rawScores.down)}`;
    dot.append(title); $('decision-dots').append(dot);
  }
  if (activePulse) $('decision-pulse').setAttribute('transform', `translate(${x(activePulse.referenceAt)} ${y(activePulse.price)})`);
  if (Number.isFinite(anchor)) { $('anchor-line').style.display = ''; $('anchor-line').setAttribute('y1', y(anchor)); $('anchor-line').setAttribute('y2', y(anchor)); }
}
for (const y of [25, 85, 145, 205]) {
  const line = document.createElementNS('http://www.w3.org/2000/svg', 'line');
  for (const [k, v] of Object.entries({ x1: 0, x2: 850, y1: y, y2: y })) line.setAttribute(k, v);
  $('chart-grid').append(line);
}
function render(s) {
  state = s; lastReceived = Date.now();
  const demo = s.dataMode === 'demo', m = s.snapshot?.market, d = s.decision ?? (s.lastEvaluation?.slug === m?.slug ? s.lastEvaluation?.decision : null), a = s.account;
  const points = s.decisionPoints ?? [], newest = points.at(-1), direction = directionOf(d);
  const isNew = shouldPulse(newest, lastPointId, initialized, s.serverTime);
  if (isNew) pulseDecision(newest, points.at(-2));
  if (newest) lastPointId = newest.id;
  initialized = true;
  set('data-mode', demo ? 'DEMO DATA' : 'LIVE DATA');
  set('model-name', s.model); set('cash', usd(a.cash)); set('bankroll', `Starting bankroll ${usd(a.bankroll)}`);
  set('settlement-label', demo ? 'Held to simulated settlement' : 'Held to official settlement');
  set('realized-note', demo ? 'Simulated-settled demo positions only' : 'Settled paper positions only');
  set('pnl', `${a.realizedPnl > 0 ? '+' : ''}${usd(a.realizedPnl)}`); $('pnl').className = a.realizedPnl >= 0 ? 'up' : 'down';
  set('exposure', usd(a.exposure)); set('positions', `${a.openTrades} awaiting settlement / cap ${usd(s.risk.maxExposure)}`);
  set('winrate', a.settledTrades ? pct(a.wins / a.settledTrades) : '—'); set('settled', `${a.settledTrades} settled · ${a.wins} won`);
  const warning = s.error || s.settlementError;
  $('notice').className = `notice${warning ? ' error' : ''}`;
  set('notice', warning ? `Recovering: ${warning}${s.settlementError ? ' · unsettled positions are kept' : ''}` : demo ? 'Demo mode: market data, model scores and settlement are synthetic and only exercise the pipeline. Set DATA_MODE=live for real markets.' : s.model === 'mock-heuristic' ? 'Live data / mock scores: a test heuristic is in use. Configure TYPESAFE_AI_API_KEY and set MODEL=jev to enable Jev.' : 'Live data / Jev decisions / paper execution: all P&L comes from a simulated ledger; the strategy is not validated.');
  const act = s.signal.action;
  set('action', act === 'wait' ? 'WAIT' : act === 'sell' ? `SELL ${s.signal.exit.side.toUpperCase()}` : `BUY ${act.toUpperCase()}`);
  $('action').className = act === 'wait' ? '' : act === 'sell' ? s.signal.exit.side : act;
  set('reason', s.signal.reason); set('raw-up-score', pct(d?.rawScores.up)); set('raw-down-score', pct(d?.rawScores.down));
  for (const side of ['up', 'down']) { $(`raw-${side}-meter`).style.width = `${(d?.rawScores[side] ?? 0) * 100}%`; $(`raw-${side}-card`).classList.toggle('selected', direction === side); }
  $('signal-box').dataset.direction = direction ?? 'neutral';
  $('signal-box').dataset.evaluationId = newest?.id ?? '';
  set('model-direction', direction === 'up' ? '↗ UP' : direction === 'down' ? '↘ DOWN' : direction === 'neutral' ? 'NEUTRAL' : '—');
  set('direction-score', d ? pct(Math.max(d.rawScores.up, d.rawScores.down)) : '—');
  set('decision-sequence', points.length ? `Decision #${points.length}` : 'Waiting');
  set('decision-time', d ? time(d.at) : '—');
  $('chart-direction').className = `chart-direction ${direction ?? ''}`;
  set('chart-evaluation', newest ? `${time(newest.at)} · ${points.length} decisions this round` : 'Each dot is one model decision');
  set('up-score', pct(d?.scores.up)); set('down-score', pct(d?.scores.down));
  $('score-up').style.width = `${(d?.scores.up ?? .5) * 100}%`;
  $('score-bar')?.setAttribute('aria-label', d ? `Up ${pct(d.scores.up)}, Down ${pct(d.scores.down)}` : 'No model score yet');
  set('score-caption', `Weight ${s.risk.scoreWeight}`);
  set('latency', d ? `${Math.round(d.latencyMs)} ms` : '—'); set('min-edge', `≥ ${cents(s.risk.minEdge)} / share`); set('trade-size', usd(s.risk.tradeUsd));
  set('feed', demo ? s.feed : `${m?.source ?? 'Chainlink'} · ${s.feed}`);
  set('cycle-duration', s.cadence?.cycleMs === null || !s.cadence ? '—' : `${(s.cadence.cycleMs / 1000).toFixed(2)} s`);
  $('pause').hidden = !s.controls;
  $('pause').disabled = false; $('pause').textContent = s.paused ? 'Resume ▷' : 'Pause Ⅱ';
  if (m) {
    set('window', `${new Date(m.startMs).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' })} · ${time(m.startMs)} — ${time(m.endMs)}`);
    set('reference-label', demo ? 'Synthetic reference · DEMO' : m.source.toUpperCase());
    set('reference', usd(s.snapshot.reference?.price)); set('anchor', usd(m.anchor?.price));
    const delta = m.anchor && s.snapshot.reference ? s.snapshot.reference.price / m.anchor.price - 1 : null;
    set('price-change', delta === null ? '—' : `${delta >= 0 ? '+' : ''}${(delta * 100).toFixed(3)}%`); $('price-change').className = `price-change ${delta >= 0 ? 'up' : 'down'}`;
    set('chart-start', time(m.startMs)); set('chart-end', time(m.endMs));
    set('anchor-source', m.anchor ? ({ 'gamma-metadata': 'Official market metadata', 'rtds-exact-boundary': 'RTDS exact opening tick', demo: 'Synthetic opening price' }[m.anchor.source]) : 'No price to beat · skipping round');
    for (const side of ['up', 'down']) { set(`${side}-ask`, cents(s.snapshot.books[side].asks[0]?.price)); set(`${side}-bid`, `Bid ${cents(s.snapshot.books[side].bids[0]?.price)}`); }
    $('market-link').hidden = demo; if (!demo) $('market-link').href = `https://polymarket.com/event/${encodeURIComponent(m.slug)}`;
  }
  renderPerp(s.snapshot?.perp, s.snapshot?.at);
  const tape = $('decision-tape'); tape.replaceChildren();
  for (const point of points.slice(-120)) { const item = document.createElement('i'); item.className = point.direction; item.title = `${time(point.at)} · ${point.direction.toUpperCase()}`; tape.append(item); }
  paintChart(s.snapshot, points);
  const tradeSignature = JSON.stringify(s.trades);
  if (tradeSignature !== lastTradeSignature) { renderTrades(s.trades); lastTradeSignature = tradeSignature; }
  renderEvents(s.events); refreshClock();
}
const signed = (n, digits, unit = '') => Number.isFinite(n) ? `${n >= 0 ? '+' : ''}${n.toFixed(digits)}${unit}` : '—';
const tone = (id, n) => { $(id).className = Number.isFinite(n) && n !== 0 ? (n > 0 ? 'up' : 'down') : ''; };
function renderPerp(p, at) {
  set('perp-age', p ? `${p.source === 'demo' ? 'Synthetic · ' : ''}${Math.max(0, (at - p.at) / 1000).toFixed(1)}s ago` : 'No data or stale · treated as unknown');
  set('perp-mid', p ? `${usd(p.mid)} · ${signed(p.basisVsChainlinkSpotBps, 1, 'bp')}` : '—');
  set('perp-book', p ? signed(p.depthImbalance.top5, 2) : '—'); tone('perp-book', p?.depthImbalance.top5);
  const f = p?.takerFlow.seconds30;
  set('perp-flow', f ? `${f.buyBtc.toFixed(1)} / ${f.sellBtc.toFixed(1)} BTC` : '—'); tone('perp-flow', f?.imbalance);
  set('perp-ret', p ? `${signed(p.returnsBps.seconds30, 1)} / ${signed(p.sinceWindowStartBps, 1)} bp` : '—'); tone('perp-ret', p?.returnsBps.seconds30);
}
function renderTrades(trades) {
  $('trades').replaceChildren(); $('trades-empty').hidden = trades.length > 0;
  for (const t of trades.slice(0, 12)) {
    const row = document.createElement('tr');
    const cells = [time(t.openedAt), t.side.toUpperCase(), cents(t.averagePrice), t.shares.toFixed(2), usd(t.total), t.settledAt === null ? 'Open' : `${t.exit ? `Sold ${cents(t.exit.averagePrice)} · ` : ''}${t.pnl > 0 ? '+' : ''}${usd(t.pnl)}`];
    if (state.dataMode === 'demo' && t.settledAt === null) cells[5] = 'Awaiting simulated settlement';
    cells.forEach((text, i) => { const td = document.createElement('td'); td.textContent = text; if (i === 1) td.className = t.side; if (i === 5 && t.pnl !== null) td.className = t.pnl >= 0 ? 'up' : 'down'; row.append(td); });
    $('trades').append(row);
  }
}
function renderEvents(events) {
  if (events[0]?.id === lastRenderedEventId) return;
  const previousNewest = lastRenderedEventId;
  lastRenderedEventId = events[0]?.id;
  $('events').replaceChildren(); $('events-empty').hidden = events.length > 0;
  for (const e of events.filter(e => e.kind !== 'model-evaluation').slice(0, 10)) {
    const li = document.createElement('li'), clock = document.createElement('time'), p = document.createElement('p'), kind = document.createElement('small');
    const direction = directionOf(e.decision);
    clock.textContent = time(e.at); kind.textContent = direction ? `JEV ${direction.toUpperCase()} · UP ${pct(e.decision.rawScores.up)} / DOWN ${pct(e.decision.rawScores.down)}` : e.kind.toUpperCase();
    if (direction) li.dataset.direction = direction;
    if (previousNewest !== null && e.id > previousNewest) li.classList.add('new-event');
    p.append(kind, document.createTextNode(e.signal?.reason ?? e.message ?? (e.kind === 'paper-exit' ? `Paper sell · P&L ${usd(e.pnl)}` : e.pnl !== null ? `Settlement P&L ${usd(e.pnl)}` : e.kind === 'paper-fill' ? 'Paper buy recorded' : e.kind === 'model-evaluation' ? 'Model input and output recorded' : 'Trading control updated')));
    li.append(clock, p); $('events').append(li);
  }
}
function refreshClock() {
  if (!state) return;
  const now = state.serverTime + Date.now() - lastReceived, m = state.snapshot?.market;
  const d = state.decision ?? (state.lastEvaluation?.slug === m?.slug ? state.lastEvaluation.decision : null);
  const points = state.decisionPoints ?? [], newest = points.at(-1), previous = points.at(-2), direction = directionOf(d);
  const age = d ? Math.max(0, now - d.at) : 0;
  const oldDecision = d && (age > state.risk.maxDataAgeMs || !connected);
  // The engine makes no Jev calls in the last seconds of a round; the next call comes when the next round opens.
  const stopSeconds = state.cadence?.modelStopSecondsLeft ?? 0;
  const quiet = Boolean(m && stopSeconds > 0 && m.endMs - now < stopSeconds * 1000);
  const flipped = !oldDecision && newest && previous && newest.direction !== previous.direction;
  $('signal-box').dataset.stale = String(Boolean(oldDecision));
  set('direction-change', quiet && d ? `Last decision of this round · ${Math.floor(age / 1000)}s ago · Jev pauses in the last ${stopSeconds}s` : oldDecision ? `Earlier decision · ${Math.floor(age / 1000)}s ago · waiting for update` : flipped ? `${previous.direction.toUpperCase()} → ${newest.direction.toUpperCase()} · direction flipped` : d ? 'Latest decision · raw model score' : 'Decides once market data is complete');
  $('direction-change').className = oldDecision ? 'expired' : flipped ? 'flipped' : '';
  set('chart-direction', direction ? `${oldDecision ? 'Last ' : ''}JEV ${direction === 'up' ? '↗ UP' : direction === 'down' ? '↘ DOWN' : 'NEUTRAL'} ${pct(Math.max(d.rawScores.up, d.rawScores.down))}` : 'Waiting for Jev');
  if (m) { const seconds = Math.max(0, Math.floor((m.endMs - now) / 1000)); set('countdown', `${String(Math.floor(seconds / 60)).padStart(2, '0')}:${String(seconds % 60).padStart(2, '0')}`); }
  const stale = !connected || Date.now() - lastReceived > 20000 || state.error || (state.snapshot && now - state.snapshot.at > state.risk.maxDataAgeMs);
  set('connection', stale ? 'Waiting for data' : 'Engine connected'); $('connection-dot').style.background = stale ? '#dda671' : '#c2ee82';
  set('updated', state.updatedAt ? `Last evaluated ${time(state.updatedAt)} · ${state.risk.dailyLossLimit === null ? 'daily loss limit off' : `daily loss limit ${usd(state.risk.dailyLossLimit)} (UTC)`}` : 'Waiting for first evaluation');
  const cadence = state.cadence;
  if (cadence) {
    set('cadence-target', `Target ${(cadence.targetMs / 1000).toFixed(1)}s`);
    set('cadence-actual', newest && previous ? `Interval ${((newest.at - previous.at) / 1000).toFixed(2)}s` : 'Interval —');
    const elapsed = cadence.cycleStartedAt === null ? 0 : Math.max(0, now - cadence.cycleStartedAt);
    const late = state.busy && elapsed > cadence.targetMs;
    let status;
    if (!connected) status = 'Disconnected, waiting to recover';
    else if (state.paused) status = 'Decisions and entries paused';
    else if (state.error) status = 'Request failed, retrying with backoff';
    else if (late) status = `Request running for ${(elapsed / 1000).toFixed(1)}s · waiting, not queuing more`;
    else if (quiet) status = `No Jev calls in the last ${stopSeconds}s · next evaluation when the next round opens in ${Math.max(0, (m.endMs - now) / 1000).toFixed(1)}s`;
    else if (state.busy) status = ({ 'market-data': 'Reading live market data…', inference: 'Jev is deciding…', quotes: 'Re-checking latest quotes…' })[cadence.stage] ?? 'Evaluating…';
    else status = `Next evaluation in ${Math.max(0, (cadence.nextTickAt - now) / 1000).toFixed(1)}s`;
    set('cycle-status', status); $('cycle-status').className = late || state.error ? 'delayed' : '';
    $('cadence-progress').style.width = `${state.paused || !connected || quiet ? 0 : Math.min(100, elapsed / cadence.targetMs * 100)}%`;
  }
}
$('pause').addEventListener('click', async () => {
  $('pause').disabled = true;
  try {
    const r = await fetch(`${API_BASE}/api/control`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ paused: !state.paused }) });
    if (!r.ok) throw new Error('Could not change trading state');
  } catch (e) { set('notice', e.message); }
  finally { $('pause').disabled = false; }
});
// EventSource gives up for good on a non-200 reply (e.g. 503 when the server is full), so reconnect ourselves
// with jittered backoff; the browser's own retry still handles plain network drops.
let retries = 0;
function connect() {
  const events = new EventSource(`${API_BASE}/events`);
  events.onopen = () => { connected = true; retries = 0; refreshClock(); };
  // Full state on connect, then small patches against it.
  let base = null;
  events.addEventListener('state', e => { try { base = JSON.parse(e.data); render(base); } catch (error) { set('notice', `Dashboard update failed: ${error.message}`); } });
  events.addEventListener('patch', e => {
    if (!base) return;
    try { base = applyPatch(base, JSON.parse(e.data)); render(base); } catch (error) { set('notice', `Dashboard update failed: ${error.message}`); events.close(); connect(); }
  });
  events.onerror = () => {
    connected = false; refreshClock();
    if (events.readyState !== EventSource.CLOSED) return;
    const delay = Math.min(60000, 5000 * 2 ** Math.min(retries++, 4)) * (0.5 + Math.random());
    $('notice').className = 'notice error';
    set('notice', `The server is busy or unreachable. Retrying in ${Math.round(delay / 1000)}s…`);
    setTimeout(connect, delay);
  };
}
// The experiment is over: the engine is gone and the dashboard no longer connects to anything. The code above is
// kept as the record of how the page worked; `connect()` and the clock are deliberately not started.
set('data-mode', 'STOPPED');
set('connection', 'Engine stopped');
$('connection-dot').style.background = '#dda671';
set('notice', 'The decision engine has been stopped and this dashboard no longer connects to it.');
import { directionOf, shouldPulse } from './decision-view.js';
import { applyPatch } from './state-patch.js';
import { API_BASE } from './config.js';
