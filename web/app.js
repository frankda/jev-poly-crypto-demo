const $ = id => document.getElementById(id);
const usd = n => Number.isFinite(n) ? new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', minimumFractionDigits: 2 }).format(n) : '—';
const pct = n => Number.isFinite(n) ? `${(n * 100).toFixed(1)}%` : '—';
const cents = n => Number.isFinite(n) ? `${(n * 100).toFixed(1)}¢` : '—';
const time = t => new Date(t).toLocaleTimeString('zh-CN', { hour12: false });
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
  $('decision-dots').replaceChildren(); chartGeom = null;
  if (activePulse?.slug !== snapshot?.market.slug) { activePulse = null; $('decision-pulse').replaceChildren(); }
  if (ticks.length < 2) { refreshHover(); return; }
  const low = Math.min(...values), high = Math.max(...values), padding = Math.max((high - low) * .2, 5);
  const x = t => (t - snapshot.market.startMs) / 300000 * 850;
  const y = price => 205 - (price - low + padding) / (high - low + 2 * padding) * 190;
  const points = ticks.map(t => `${x(t.timestamp).toFixed(2)},${y(t.price).toFixed(2)}`);
  $('chart-path').setAttribute('d', `M${points.join(' L')}`);
  $('chart-area').setAttribute('d', `M${x(ticks[0].timestamp)},220 L${points.join(' L')} L${x(ticks.at(-1).timestamp)},220 Z`);
  $('chart-dot').style.display = ''; $('chart-dot').setAttribute('cx', x(ticks.at(-1).timestamp)); $('chart-dot').setAttribute('cy', y(ticks.at(-1).price));
  for (const point of pointsOnChart) {
    $('decision-dots').append(svgElement('circle', { cx: x(point.referenceAt), cy: y(point.price), r: point.id === decisions.at(-1)?.id ? 4 : 2.6, class: point.direction }));
  }
  chartGeom = { x, y, points: pointsOnChart };
  if (activePulse) $('decision-pulse').setAttribute('transform', `translate(${x(activePulse.referenceAt)} ${y(activePulse.price)})`);
  if (Number.isFinite(anchor)) { $('anchor-line').style.display = ''; $('anchor-line').setAttribute('y1', y(anchor)); $('anchor-line').setAttribute('y2', y(anchor)); }
  refreshHover();
}
// Hover inspection: snap to the nearest decision point and show its Jev scores and Polymarket quotes.
let chartGeom = null, hoverId = null;
function hideHover() {
  hoverId = null;
  for (const id of ['hover-line', 'hover-ring', 'chart-tip']) $(id).hidden = true;
}
function showHover(point) {
  const { x, y, points } = chartGeom, cx = x(point.referenceAt), cy = y(point.price);
  $('hover-line').setAttribute('x1', cx); $('hover-line').setAttribute('x2', cx); $('hover-line').hidden = false;
  $('hover-ring').setAttribute('cx', cx); $('hover-ring').setAttribute('cy', cy); $('hover-ring').hidden = false;
  const tip = $('chart-tip'); tip.replaceChildren();
  for (const [label, value, tone] of tooltipRows(point, points.indexOf(point), time, usd)) {
    if (tone === 'title') { const t = document.createElement('p'); t.className = 'title'; t.textContent = label; tip.append(t); continue; }
    const row = document.createElement('div'), l = document.createElement('span'), v = document.createElement('strong');
    row.className = 'row'; l.textContent = label; v.textContent = value; if (tone) v.className = tone;
    row.append(l, v); tip.append(row);
  }
  tip.hidden = false;
  // Map the point from SVG units to pixels inside .chart-wrap, then keep the box on-screen.
  const svg = $('chart'), m = svg.getScreenCTM(), wrap = tip.parentElement.getBoundingClientRect();
  if (!m) return;
  const px = cx * m.a + m.e - wrap.left, py = cy * m.d + m.f - wrap.top;
  const left = px + 14 + tip.offsetWidth > wrap.width ? px - 14 - tip.offsetWidth : px + 14;
  tip.style.left = `${Math.max(0, left)}px`;
  tip.style.top = `${Math.min(Math.max(0, py - tip.offsetHeight / 2), wrap.height - tip.offsetHeight)}px`;
}
function refreshHover() {
  const point = chartGeom && hoverId !== null ? chartGeom.points.find(p => p.id === hoverId) : null;
  point ? showHover(point) : hideHover();
}
function onChartPointer(event) {
  const svg = $('chart'), m = svg.getScreenCTM();
  if (!chartGeom || !m) return hideHover();
  const vx = (event.clientX - m.e) / m.a;
  const point = nearestPoint(chartGeom.points, chartGeom.x, vx);
  if (!point) return hideHover();
  hoverId = point.id; showHover(point);
}
$('chart').addEventListener('pointermove', onChartPointer);
$('chart').addEventListener('pointerdown', onChartPointer);
$('chart').addEventListener('pointerleave', hideHover);
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
  set('model-name', s.model); set('cash', usd(a.cash)); set('bankroll', `初始模拟资金 ${usd(a.bankroll)}`);
  set('settlement-label', demo ? '持有至模拟轮次结算' : '持有至官方结算');
  set('realized-note', demo ? '仅统计已模拟结算的演示仓位' : '仅统计已正式结算的模拟仓位');
  set('pnl', `${a.realizedPnl > 0 ? '+' : ''}${usd(a.realizedPnl)}`); $('pnl').className = a.realizedPnl >= 0 ? 'up' : 'down';
  set('exposure', usd(a.exposure)); set('positions', `${a.openTrades} 笔等待结算 / 上限 ${usd(s.risk.maxExposure)}`);
  set('winrate', a.settledTrades ? pct(a.wins / a.settledTrades) : '—'); set('settled', `已结算 ${a.settledTrades} 笔 · 盈利 ${a.wins} 笔`);
  const warning = s.error || s.settlementError;
  $('notice').className = `notice${warning ? ' error' : ''}`;
  set('notice', warning ? `等待恢复：${warning}${s.settlementError ? ' · 未结算仓位继续保留' : ''}` : demo ? '演示模式：行情、模型评分和结算均为合成数据，仅用于验证流程。切换真实行情需设置 DATA_MODE=live。' : s.model === 'mock-heuristic' ? '真实行情 / Mock 评分：当前使用测试规则。配置 TYPESAFE_AI_API_KEY 并设置 MODEL=jev 后启用 Jev。' : '真实行情 / Jev 决策 / 模拟执行：所有盈亏来自本地模拟账本，尚未验证策略有效性。');
  const act = s.signal.action;
  set('action', act === 'wait' ? 'WAIT / 观望' : act === 'sell' ? `SELL ${s.signal.exit.side.toUpperCase()}` : `BUY ${act.toUpperCase()}`);
  $('action').className = act === 'wait' ? '' : act === 'sell' ? s.signal.exit.side : act;
  set('reason', s.signal.reason); set('raw-up-score', pct(d?.rawScores.up)); set('raw-down-score', pct(d?.rawScores.down));
  for (const side of ['up', 'down']) { $(`raw-${side}-meter`).style.width = `${(d?.rawScores[side] ?? 0) * 100}%`; $(`raw-${side}-card`).classList.toggle('selected', direction === side); }
  $('signal-box').dataset.direction = direction ?? 'neutral';
  $('signal-box').dataset.evaluationId = newest?.id ?? '';
  set('model-direction', direction === 'up' ? '↗ UP' : direction === 'down' ? '↘ DOWN' : direction === 'neutral' ? 'NEUTRAL' : '—');
  set('direction-score', d ? pct(Math.max(d.rawScores.up, d.rawScores.down)) : '—');
  set('decision-sequence', points.length ? `本轮 #${points.length}` : '等待判断');
  set('decision-time', d ? time(d.at) : '—');
  $('chart-direction').className = `chart-direction ${direction ?? ''}`;
  set('chart-evaluation', newest ? `${time(newest.at)} · 本轮 ${points.length} 次判断` : '每个点对应一次模型判断');
  set('up-score', pct(d?.scores.up)); set('down-score', pct(d?.scores.down));
  $('score-up').style.width = `${(d?.scores.up ?? .5) * 100}%`;
  $('score-bar')?.setAttribute('aria-label', d ? `Up ${pct(d.scores.up)}, Down ${pct(d.scores.down)}` : '暂无模型评分');
  set('score-caption', `权重 ${s.risk.scoreWeight}`);
  set('latency', d ? `${Math.round(d.latencyMs)} ms` : '—'); set('min-edge', `≥ ${cents(s.risk.minEdge)} / 份`); set('trade-size', usd(s.risk.tradeUsd));
  set('feed', demo ? s.feed : `${m?.source ?? 'Chainlink'} · ${s.feed}`);
  set('cycle-duration', s.cadence?.cycleMs === null || !s.cadence ? '—' : `${(s.cadence.cycleMs / 1000).toFixed(2)} s`);
  $('pause').hidden = !s.controls;
  $('pause').disabled = false; $('pause').textContent = s.paused ? '恢复判断 ▷' : '暂停判断 Ⅱ';
  if (m) {
    set('window', `${new Date(m.startMs).toLocaleDateString('zh-CN')} · ${time(m.startMs)} — ${time(m.endMs)}`);
    set('reference-label', demo ? '合成参考价格 · DEMO' : m.source.toUpperCase());
    set('reference', usd(s.snapshot.reference?.price)); set('anchor', usd(m.anchor?.price));
    const delta = m.anchor && s.snapshot.reference ? s.snapshot.reference.price / m.anchor.price - 1 : null;
    set('price-change', delta === null ? '—' : `${delta >= 0 ? '+' : ''}${(delta * 100).toFixed(3)}%`); $('price-change').className = `price-change ${delta >= 0 ? 'up' : 'down'}`;
    set('chart-start', time(m.startMs)); set('chart-end', time(m.endMs));
    set('anchor-source', m.anchor ? ({ 'gamma-metadata': '官方市场元数据', 'rtds-exact-boundary': 'RTDS 精确开盘时刻', demo: '合成开盘基准价' }[m.anchor.source]) : '缺少开盘基准价 · 跳过本轮');
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
  set('perp-age', p ? `${p.source === 'demo' ? '合成 · ' : ''}${Math.max(0, (at - p.at) / 1000).toFixed(1)}s 前` : '无数据或已过期 · 按未知处理');
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
    const cells = [time(t.openedAt), t.side.toUpperCase(), cents(t.averagePrice), t.shares.toFixed(2), usd(t.total), t.settledAt === null ? '持有中' : `${t.exit ? `卖出 ${cents(t.exit.averagePrice)} · ` : ''}${t.pnl > 0 ? '+' : ''}${usd(t.pnl)}`];
    if (state.dataMode === 'demo' && t.settledAt === null) cells[5] = '等待模拟结算';
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
    p.append(kind, document.createTextNode(e.signal?.reason ?? e.message ?? (e.kind === 'paper-exit' ? `模拟卖出 · 收益 ${usd(e.pnl)}` : e.pnl !== null ? `结算收益 ${usd(e.pnl)}` : e.kind === 'paper-fill' ? '模拟买入已记录' : e.kind === 'model-evaluation' ? '模型输入与输出已记录' : '开仓控制已更新')));
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
  const flipped = !oldDecision && newest && previous && newest.direction !== previous.direction;
  $('signal-box').dataset.stale = String(Boolean(oldDecision));
  set('direction-change', oldDecision ? `历史判断 · ${Math.floor(age / 1000)} 秒前 · 等待更新` : flipped ? `${previous.direction.toUpperCase()} → ${newest.direction.toUpperCase()} · 方向切换` : d ? '最新判断 · 原始模型评分' : '等待完整行情后判断');
  $('direction-change').className = oldDecision ? 'expired' : flipped ? 'flipped' : '';
  set('chart-direction', direction ? `${oldDecision ? '最近 ' : ''}JEV ${direction === 'up' ? '↗ UP' : direction === 'down' ? '↘ DOWN' : 'NEUTRAL'} ${pct(Math.max(d.rawScores.up, d.rawScores.down))}` : '等待 Jev 判断');
  if (m) { const seconds = Math.max(0, Math.floor((m.endMs - now) / 1000)); set('countdown', `${String(Math.floor(seconds / 60)).padStart(2, '0')}:${String(seconds % 60).padStart(2, '0')}`); }
  const stale = !connected || Date.now() - lastReceived > 20000 || state.error || (state.snapshot && now - state.snapshot.at > state.risk.maxDataAgeMs);
  set('connection', stale ? '等待数据' : '引擎已连接'); $('connection-dot').style.background = stale ? '#dda671' : '#c2ee82';
  set('updated', state.updatedAt ? `最后评估 ${time(state.updatedAt)} · ${state.risk.dailyLossLimit === null ? '当日亏损上限已关闭' : `当日亏损上限 ${usd(state.risk.dailyLossLimit)}（UTC）`}` : '等待首次评估');
  const cadence = state.cadence;
  if (cadence) {
    set('cadence-target', `目标 ${(cadence.targetMs / 1000).toFixed(1)}s`);
    set('cadence-actual', newest && previous ? `返回间隔 ${((newest.at - previous.at) / 1000).toFixed(2)}s` : '返回间隔 —');
    const elapsed = cadence.cycleStartedAt === null ? 0 : Math.max(0, now - cadence.cycleStartedAt);
    const late = state.busy && elapsed > cadence.targetMs;
    let status;
    if (!connected) status = '连接中断，等待恢复';
    else if (state.paused) status = '已暂停判断与开仓';
    else if (state.error) status = '请求失败，退避后重试';
    else if (late) status = `本次请求已耗时 ${(elapsed / 1000).toFixed(1)}s · 等待返回，不堆积请求`;
    else if (state.busy) status = ({ 'market-data': '读取实时行情…', inference: 'Jev 正在判断…', quotes: '复核最新盘口…' })[cadence.stage] ?? '正在评估…';
    else status = `下次评估 ${Math.max(0, (cadence.nextTickAt - now) / 1000).toFixed(1)}s 后`;
    set('cycle-status', status); $('cycle-status').className = late || state.error ? 'delayed' : '';
    $('cadence-progress').style.width = `${state.paused || !connected ? 0 : Math.min(100, elapsed / cadence.targetMs * 100)}%`;
  }
}
$('pause').addEventListener('click', async () => {
  $('pause').disabled = true;
  try {
    const r = await fetch(`${API_BASE}/api/control`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ paused: !state.paused }) });
    if (!r.ok) throw new Error('无法更改开仓状态');
  } catch (e) { set('notice', e.message); }
  finally { $('pause').disabled = false; }
});
const events = new EventSource(`${API_BASE}/events`);
events.onopen = () => { connected = true; refreshClock(); };
events.addEventListener('state', e => { try { render(JSON.parse(e.data)); } catch (error) { set('notice', `界面更新失败：${error.message}`); } });
events.onerror = () => { connected = false; refreshClock(); };
setInterval(refreshClock, 100);
import { directionOf, nearestPoint, shouldPulse, tooltipRows } from './decision-view.js';
import { API_BASE } from './config.js';
