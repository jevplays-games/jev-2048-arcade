import {ACTION_NAMES, getLegalActions, simulateMove, tileValue, createDuel} from './core/rules.js';
import {analyze, csv} from './core/analytics.js';
import {verifyBundle, verifyChain} from './core/audit.js';
const $ = id => document.getElementById(id);
const fmt = value => Number.isFinite(value) ? new Intl.NumberFormat(undefined, {maximumFractionDigits: 0}).format(value) : '—';
const dec = (value, places = 2) => Number.isFinite(value) ? value.toFixed(places) : '—';
const percent = value => Number.isFinite(value) ? `${(value * 100).toFixed(1)}%` : '—';
const store = {get(key, fallback = null) { try { return localStorage.getItem(key) ?? fallback; } catch { return fallback; } },
  set(key, value) { try { localStorage.setItem(key, value); } catch { /* Storage is optional. */ } }};
let me = null, match = null, events = [], busy = false, currentTab = 'decision', analytics = null,
  imported = null, lastServerMatchId = null, replayRound = null, eventSync = null, lastSettled = performance.now(),
  telemetryEnabled = store.get('telemetry', 'false') === 'true', telemetryQueue = [], telemetryTimer = null,
  leaderScope = 'world', leaderOffset = 0, nextLeaderOffset = null, autoOpponent = false;
async function api(path, {method = 'GET', body} = {}) {
  const response = await fetch(path, {method, credentials: 'same-origin', headers: {
    ...(body === undefined ? {} : {'Content-Type': 'application/json'}),
    ...(me?.csrf ? {'X-CSRF-Token': me.csrf} : {})},
    ...(body === undefined ? {} : {body: JSON.stringify(body)}), signal: AbortSignal.timeout(60000)});
  let data; try { data = await response.json(); } catch { throw new Error(`Server returned HTTP ${response.status}.`); }
  if (!response.ok) { const error = new Error(data.error || 'Request failed.'); Object.assign(error, {status: response.status, code: data.code, details: data.details}); throw error; }
  return data;
}
function status(text) { $('game-status').textContent = text; }
function showError(error) { $('error-banner').textContent = typeof error === 'string' ? error : error.message; $('error-banner').hidden = false; }
function clearError() { $('error-banner').hidden = true; }
function telemetry(type, data = {}) {
  if (!telemetryEnabled || !match || imported) return;
  telemetryQueue.push({id: crypto.randomUUID(), type, data});
  if (telemetryQueue.length > 100) telemetryQueue.shift();
  if (!telemetryTimer) telemetryTimer = setTimeout(flushTelemetry, 1500);
}
async function flushTelemetry() {
  telemetryTimer = null;
  if (!telemetryEnabled || !match || imported) { telemetryQueue = []; return; }
  const batch = telemetryQueue.splice(0, 20);
  if (!batch.length) return;
  try { await api(`/api/matches/${match.id}/telemetry`, {method: 'POST', body: {events: batch}}); }
  catch { /* Optional browser telemetry never blocks gameplay and is not silently retried forever. */ }
  if (telemetryQueue.length) telemetryTimer = setTimeout(flushTelemetry, 2200);
}
function createBoard(id) {
  const fragment = document.createDocumentFragment();
  for (let r = 0; r < 4; r++) {
    const row = document.createElement('div'); row.className = 'board-row'; row.setAttribute('role', 'row');
    for (let c = 0; c < 4; c++) {
      const cell = document.createElement('div'); cell.className = 'tile'; cell.dataset.cell = r * 4 + c;
      cell.setAttribute('role', 'gridcell'); cell.setAttribute('aria-label', `Row ${r + 1}, column ${c + 1}: empty`); row.append(cell);
    }
    fragment.append(row);
  }
  $(id).replaceChildren(fragment);
}
function renderBoard(actor, board, details = null, preview = false) {
  const el = $(actor + '-board'); el.classList.toggle('preview', preview);
  const cells = board?.cells || Array(16).fill(0);
  el.querySelectorAll('.tile').forEach((tile, index) => {
    const exponent = cells[index], value = tileValue(exponent);
    tile.textContent = value ? fmt(value) : ''; tile.dataset.e = exponent;
    tile.className = 'tile' + (exponent >= 12 ? ' large' : '') +
      (details?.spawn?.cell === index ? ' spawn' : '') + (details?.merges?.some(m => m.to === index) ? ' merged' : '');
    tile.setAttribute('aria-label', `Row ${Math.floor(index / 4) + 1}, column ${index % 4 + 1}: ${value || 'empty'}`);
  });
  $(actor + '-score').textContent = fmt(board?.score || 0);
  $(actor + '-max').textContent = fmt(Math.max(...cells.map(tileValue)));
  $(actor + '-empty').textContent = cells.filter(x => !x).length;
  $(actor + '-state').textContent = board ? ({playing: `${board.moves} moves`, blocked: 'No legal moves', move_cap: 'Move limit reached'}[board.status] || board.status) : 'Ready';
  $(actor + '-gain').textContent = details?.scoreDelta ? `+${fmt(details.scoreDelta)} THIS ROUND` :
    actor === 'human' ? 'YOUR NEXT MOVE COUNTS' : 'AWAITING YOUR MOVE';
}
function latestRound() { return events.findLast(e => e.type === 'round_committed'); }
function active() { return match && match.status === 'active' && !imported && replayRound === null; }
function renderMatch(details = null) {
  const state = match?.state;
  renderBoard('human', state?.human, details?.human); renderBoard('jev', state?.jev, details?.jev);
  const local = match?.mode === 'local' || (!match && $('opponent').value === 'local');
  $('opponent-label').textContent = local ? 'LOCAL HEURISTIC' : 'JEV';
  $('jev-caption').textContent = local ? 'Practice, clearly labeled.' : 'Structured, not scripted.';
  $('round-label').textContent = `ROUND ${fmt(state?.round || 0)} / ${fmt(state?.moveLimit || 2048)}`;
  $('eligibility').textContent = imported ? 'IMPORTED EVIDENCE' : match?.verified ? (match.ranked ? 'VERIFIED · RANKED' : 'VERIFIED · UNRANKED') :
    match?.ranked ? 'RANKED · DISCORD' : match ? (local ? 'LOCAL PRACTICE · UNRANKED' : 'JEV PRACTICE · UNRANKED') : 'READY TO PLAY';
  $('eligibility').classList.toggle('verified', Boolean(match?.verified));
  document.querySelectorAll('.direction').forEach(button => {
    button.disabled = busy || !active() || state?.human.status !== 'playing' || Boolean(match?.pending);
  });
  $('new-game').disabled = busy;
  $('retry').hidden = !match?.pending || busy || Boolean(imported) || match.status !== 'active';
  $('fallback').hidden = !match || match.mode !== 'jev' || match.status !== 'active' || Boolean(imported);
  $('fallback').disabled = busy;
  $('advance-jev').hidden = !match || match.status !== 'active' || state?.human.status === 'playing' || Boolean(imported);
  $('advance-jev').disabled = busy;
  if (state && !busy && replayRound === null) {
    if (imported) status('Inspecting an imported audit bundle. Gameplay is disabled.');
    else if (match.status === 'complete') status(state.winner === 'draw' ? `Draw · ${fmt(state.human.score)} each. ${match.verified ? 'Replay verified.' : 'Verification pending.'}` :
      `${state.winner === 'human' ? 'You win' : local ? 'The local opponent wins' : 'JEV wins'} · ${fmt(state.human.score)} to ${fmt(state.jev.score)}. ${match.verified ? 'Replay verified.' : 'Verification pending.'}`);
    else if (match.status === 'resigned') status('Match resigned. The recorded moves remain available for inspection.');
    else if (match.status === 'expired') status('Match expired. Start a new duel to continue playing.');
    else if (match.pending) status('A move is reserved. Retry it, or explicitly switch to local practice.');
    else if (state.human.status !== 'playing') status('Your board is finished. The opponent can continue; final score decides the match.');
    else status(local ? 'Local heuristic practice. Play your board to advance both boards.' : 'Your move. JEV evaluates its own board after your direction is locked.');
  }
  const manifest = match?.manifest;
  $('footer-model').textContent = manifest ? `${manifest.model || 'LOCAL HEURISTIC'} · ${manifest.policyVersion} · ${manifest.rulesVersion}` : 'Native HTML · deterministic rules · no tracking SDK';
  if (match) {
    $('replay-slider').max = String(state.round); $('replay-slider').value = String(replayRound ?? state.round);
    $('replay-round').textContent = String(replayRound ?? state.round);
  }
  renderProvenance();
}
function cell(text) { const td = document.createElement('td'); td.textContent = text; return td; }
function renderDecision() {
  const decision = latestRound()?.data.decision;
  $('metric-source').textContent = decision ? ({jev: 'JEV model', heuristic: 'Local heuristic', forced: 'Forced legal move', finished: 'Board finished'}[decision.source] || decision.source) : 'Not started';
  $('metric-candidates').textContent = decision?.candidates?.length ?? '—';
  $('metric-confidence').textContent = percent(decision?.confidence);
  $('metric-latency').textContent = Number.isFinite(decision?.latencyMs) ? `${dec(decision.latencyMs, 0)} ms` : '—';
  if (!decision?.candidates?.length) return;
  const fragment = document.createDocumentFragment();
  for (const c of decision.candidates) {
    const row = document.createElement('tr');
    const label = cell(c.name);
    if (c.action === decision.action) {
      row.className = 'selected'; const badge = document.createElement('span'); badge.className = 'selected-tag'; badge.textContent = 'SELECTED'; label.append(badge);
    }
    row.append(label, cell(`+${fmt(c.mergeGain)}`), cell(fmt(c.features.emptyCount)), cell(percent(c.features.immediateBlockProbability)),
      cell(dec(c.lookahead?.value)), cell(dec(c.utility)), cell(percent(c.confidence)));
    fragment.append(row);
  }
  $('candidate-table').replaceChildren(fragment); $('decision-json').textContent = JSON.stringify(decision, null, 2);
}
function renderProvenance() {
  if (!match) return;
  const values = {'Match ID': match.id, 'Rules': match.manifest.rulesVersion, 'Randomness': match.manifest.rngVersion,
    'Model': match.manifest.model || 'None · local heuristic', 'Policy': match.manifest.policyVersion,
    'Build': match.manifest.build?.sourceSHA256 || 'Unrecorded', 'Seed commitment': match.commitment,
    'Event count': events.length, 'Event head': events.at(-1)?.hash || 'Not loaded'};
  definitionList('provenance', values);
  const recent = events.slice(-60).reverse().map(e => {
    const row = document.createElement('div');
    for (const text of [e.seq, e.type, new Date(e.occurredAt).toLocaleTimeString()]) { const span = document.createElement('span'); span.textContent = text; row.append(span); }
    return row;
  });
  $('event-timeline').replaceChildren(...recent);
}
function definitionList(id, values) {
  const rows = Object.entries(values).map(([key, value]) => {
    const row = document.createElement('div'), dt = document.createElement('dt'), dd = document.createElement('dd');
    dt.textContent = key; dd.textContent = String(value); row.append(dt, dd); return row;
  });
  $(id).replaceChildren(...rows);
}
async function syncEvents() {
  if (!match || imported) return;
  if (eventSync) return eventSync;
  const id = match.id;
  eventSync = (async () => {
    let after = events.at(-1)?.seq || 0;
    do {
      const response = await api(`/api/matches/${id}/events?after=${after}`);
      if (match?.id !== id || imported) return;
      const known = new Set(events.map(e => e.seq));
      events.push(...response.events.filter(e => !known.has(e.seq))); events.sort((a, b) => a.seq - b.seq);
      after = response.nextAfter;
      if (busy && response.events.length) {
        const event = response.events.at(-1);
        if (event.type === 'jev_requested') status(`JEV request dispatched · attempt ${event.data.attempt}. Your direction is locked.`);
        else if (event.type === 'candidates_generated') status(`${event.data.candidates.length} legal candidates recorded. Evaluating positional evidence.`);
        else if (event.type === 'jev_response') status('Provider response recorded. Validating before applying a move.');
        else if (event.type === 'round_committed') status('Round committed. Updating the authoritative boards.');
      }
    } while (after !== null);
    renderDecision(); renderProvenance();
  })().finally(() => { eventSync = null; });
  return eventSync;
}
async function loadMatch(id) {
  clearError(); busy = true;
  try {
    const response = await api(`/api/matches/${id}`);
    match = response.match; lastServerMatchId = id; imported = null; events = []; analytics = null; replayRound = null;
    $('difficulty').value = match.manifest.difficulty; $('opponent').value = match.mode;
    await syncEvents(); store.set('lastMatch', id); busy = false; renderMatch();
    if (currentTab === 'analytics') await refreshAnalytics();
  } finally { busy = false; renderMatch(); }
}
async function startMatch() {
  clearError(); busy = true; renderMatch();
  try {
    if (match?.status === 'active' && !imported) await api(`/api/matches/${match.id}/control`, {method: 'POST', body: {action: 'resign'}});
    const mode = $('opponent').value, difficulty = $('difficulty').value;
    const response = await api('/api/matches', {method: 'POST', body: {mode, difficulty, ranked: Boolean(me.user && mode === 'jev')}});
    match = response.match; lastServerMatchId = match.id; imported = null; events = response.events; analytics = null; replayRound = null;
    store.set('difficulty', difficulty); store.set('lastMatch', match.id); lastSettled = performance.now();
    $('candidate-table').replaceChildren(emptyRow(7, 'Play a move to inspect the decision.')); $('decision-json').textContent = 'No decisions yet.';
    renderDecision();
  } catch (error) {
    if (error.code === 'active_match' && error.details?.matchId) await loadMatch(error.details.matchId); else showError(error);
  } finally { busy = false; renderMatch(); $('play-region').focus({preventScroll: true}); }
}
async function move(action, retry = false) {
  if (!active() || busy) return;
  const state = match.state, legal = state.human.status === 'playing' && getLegalActions(state.human).includes(action);
  if (!retry) telemetry('input_attempt', {action, legal: Boolean(legal), thinkMs: performance.now() - lastSettled, revision: state.revision});
  if (match.pending && !retry) { showError('A direction is already reserved. Use “Retry reserved move”.'); return; }
  if (state.human.status === 'playing' && !legal && !retry) { status('That direction changes nothing. No round or spawn was consumed.'); return; }
  if (state.human.status !== 'playing' && action !== null && !retry) return;
  const body = retry && match.pending ? match.pending : {requestId: crypto.randomUUID(), expectedRevision: state.revision, humanAction: action};
  busy = true; clearError(); renderMatch();
  if (state.human.status === 'playing') {
    const preview = simulateMove(state.human, body.humanAction);
    renderBoard('human', {...state.human, cells: preview.cells}, null, true);
  }
  status(match.mode === 'local' ? 'Committing the round against the local heuristic…' : 'Your move is locked. Waiting for JEV’s decision…');
  const start = performance.now(), polling = setInterval(() => syncEvents().catch(() => {}), 800);
  try {
    const response = await api(`/api/matches/${match.id}/step`, {method: 'POST', body}); match = response.match;
    await syncEvents(); telemetry('round_network', {rttMs: performance.now() - start, revision: match.state.revision, success: true});
    lastSettled = performance.now();
  } catch (error) {
    showError(error); telemetry('round_network', {rttMs: performance.now() - start, success: false});
    try { match = (await api(`/api/matches/${match.id}`)).match; await syncEvents(); } catch { /* Keep the reserved local input for an idempotent retry. */ match.pending = body; }
    autoOpponent = false;
  } finally {
    clearInterval(polling); busy = false; replayRound = null; renderMatch(latestRound()?.data.details);
    if (currentTab === 'analytics') await refreshAnalytics().catch(showError);
  }
  if (autoOpponent && match.status === 'active' && match.state.human.status !== 'playing' && !match.pending)
    setTimeout(() => move(null), 150);
}
function emptyRow(columns, text) { const row = document.createElement('tr'), c = cell(text); c.colSpan = columns; c.className = 'empty-state'; row.append(c); return row; }
function makeMetric(label, value, detail = '') {
  const node = document.createElement('div'); node.className = 'metric';
  for (const [tag, text] of [['span', label], ['strong', value], ['small', detail]]) { const child = document.createElement(tag); child.textContent = text; node.append(child); }
  return node;
}
const svgNS = 'http://www.w3.org/2000/svg';
function svgElement(tag, attrs = {}, text = null) {
  const node = document.createElementNS(svgNS, tag); for (const [k, v] of Object.entries(attrs)) node.setAttribute(k, v);
  if (text !== null) node.textContent = text; return node;
}
function chart(id, series, lines, label) {
  const container = $(id); container.replaceChildren();
  if (!series.length) { const p = document.createElement('p'); p.className = 'empty-state'; p.textContent = 'Play a few rounds to build this chart.'; container.append(p); return; }
  const width = 510, height = 190, left = 45, right = 10, top = 8, bottom = 26;
  const max = Math.max(1, ...lines.flatMap(line => series.map(p => Number.isFinite(p[line.key]) ? p[line.key] : 0)));
  const svg = svgElement('svg', {viewBox: `0 0 ${width} ${height}`, role: 'img', 'aria-label': label});
  svg.append(svgElement('title', {}, label));
  for (let i = 0; i <= 4; i++) {
    const y = top + (height - top - bottom) * i / 4;
    svg.append(svgElement('line', {x1: left, x2: width - right, y1: y, y2: y, class: 'grid-line'}),
      svgElement('text', {x: left - 7, y: y + 3, 'text-anchor': 'end'}, fmt(max * (1 - i / 4))));
  }
  // Bound SVG point count; extrema and all values remain available in the exports.
  const stride = Math.max(1, Math.ceil(series.length / 400));
  for (const line of lines) {
    const points = series.flatMap((p, i) => {
      if ((i % stride && i !== series.length - 1) || !Number.isFinite(p[line.key])) return [];
      return [`${left + i / Math.max(1, series.length - 1) * (width - left - right)},${top + (1 - p[line.key] / max) * (height - top - bottom)}`];
    });
    svg.append(svgElement('polyline', {points: points.join(' '), class: line.class}));
    if (series.length === 1) {
      const value = series[0][line.key];
      if (Number.isFinite(value)) svg.append(svgElement('circle', {cx: left, cy: top + (1 - value / max) * (height - top - bottom), r: 3, fill: 'currentColor'}));
    }
  }
  svg.append(svgElement('text', {x: left, y: height - 4}, 'ROUND 1'), svgElement('text', {x: width - right, y: height - 4, 'text-anchor': 'end'}, `ROUND ${series.at(-1).round}`));
  container.append(svg);
}
async function getBundle() {
  if (imported) return imported;
  if (!match) throw new Error('Start a match first.');
  await flushTelemetry(); return api(`/api/matches/${match.id}/bundle`);
}
async function refreshAnalytics() {
  if (!match) return;
  $('refresh-analytics').disabled = true;
  try {
    const bundle = await getBundle(); analytics = analyze(bundle);
    const a = analytics, human = a.actors.human, opponent = a.actors.jev;
    $('analytics-kpis').replaceChildren(makeMetric('SCORE DIFFERENCE', fmt(human.finalScore - opponent.finalScore), 'You minus opponent'),
      makeMetric('YOUR SCORE / MOVE', dec(human.scorePerMove, 1), `${fmt(human.moves)} committed moves`),
      makeMetric('JEV PROVIDER REQUESTS', fmt(a.model.requests), `${a.model.retries} retries · ${a.model.failures} failure events`),
      makeMetric('KNOWN INPUT TOKENS', fmt(a.model.usage.inputTokensKnown), `${a.model.usage.attemptsWithoutUsage} attempts without usage`));
    chart('score-chart', a.series, [{key: 'humanScore', class: 'human-line'}, {key: 'jevScore', class: 'jev-line'}], 'Score by round for both boards');
    chart('space-chart', a.series, [{key: 'humanEmpty', class: 'human-line'}, {key: 'jevEmpty', class: 'jev-line'}], 'Empty cells by round for both boards');
    chart('latency-chart', a.series, [{key: 'decisionMs', class: 'jev-line'}], 'Server decision latency in milliseconds');
    chart('mobility-chart', a.series, [{key: 'humanLegal', class: 'human-line'}, {key: 'jevLegal', class: 'jev-line'}], 'Legal move count by round');
    renderHeatmaps();
    $('direction-distribution').replaceChildren(...ACTION_NAMES.map((name, i) => {
      const row = document.createElement('div'); row.className = 'direction-stat';
      for (const value of [['↑','→','↓','←'][i], human.actions[i], opponent.actions[i]]) { const span = document.createElement('span'); span.textContent = value; row.append(span); }
      row.setAttribute('aria-label', `${name}: you ${human.actions[i]}, opponent ${opponent.actions[i]}`); return row;
    }));
    definitionList('reliability', {'Recorded events': a.eventCount, 'Live JEV decisions': a.model.decisions, 'Forced moves': a.model.forced,
      'Local heuristic moves': a.model.heuristic, 'Decision p50': `${dec(a.model.decisionLatencyMs.p50, 0)} ms`,
      'Decision p95': `${dec(a.model.decisionLatencyMs.p95, 0)} ms`, 'Mean rubric confidence': percent(a.model.confidence.mean),
      'Question entropy': `${dec(a.model.questionEntropyBits.mean)} bits`, 'Search nodes': fmt(a.model.searchNodes),
      'Truncated candidates': a.model.truncatedCandidates, 'Estimated cost': 'Not configured'});
    const fields = [
      ['Merge events', x => fmt(x.mergeCount)], ['Moves with a merge', x => percent(x.mergeMoveRate)],
      ['Largest tile in corner', x => percent(x.cornerHoldRate)], ['Direction reversals', x => fmt(x.reversals)],
      ['Longest no-merge sequence', x => fmt(x.longestNoMergeStreak)], ['Average empty cells', x => dec(x.emptyDistribution.mean)],
      ['Average legal directions', x => dec(x.legalDistribution.mean)], ['Mean monotonicity', x => dec(x.monotonicityDistribution.mean, 3)],
      ['Mean roughness', x => dec(x.roughnessDistribution.mean, 3)], ['Tile entropy', x => `${dec(x.entropyDistribution.mean)} bits`],
      ['Spawned 2 / 4 tiles', x => `${x.spawn2} / ${x.spawn4}`], ['Baseline agreement (proxy)', x => percent(x.heuristicAgreementRate)],
      ['Baseline regret (proxy)', x => dec(x.heuristicRegretDistribution.mean, 3)], ['First 2048', x => x.milestones[2048] ? `Move ${x.milestones[2048].move}` : 'Not reached']
    ];
    $('comparison-table').replaceChildren(...fields.map(([label, fn]) => { const row = document.createElement('tr'); row.append(cell(label), cell(fn(human)), cell(fn(opponent))); return row; }));
    const {roundRows, candidateRows, cellRows, series, ...summary} = a;
    $('analytics-json').textContent = JSON.stringify(summary, null, 2);
  } finally { $('refresh-analytics').disabled = false; }
}
function renderHeatmaps() {
  if (!analytics) return;
  const metric = $('heatmap-type').value;
  const max = Math.max(1, ...['human','jev'].flatMap(actor => analytics.actors[actor][metric].filter(Number.isFinite)));
  for (const actor of ['human','jev']) {
    $(actor + '-heatmap').replaceChildren(...analytics.actors[actor][metric].map((v, i) => {
      const node = document.createElement('div'); node.className = 'heat-cell';
      node.dataset.intensity = Math.ceil((v || 0) / max * 5);
      node.textContent = metric === 'occupancyRate' ? percent(v) : fmt(v);
      node.title = `Row ${Math.floor(i / 4) + 1}, column ${i % 4 + 1}: ${v ?? 'not measured'}`;
      return node;
    }));
  }
}
function inspectRound(value) {
  if (!match) return;
  const initial = events[0]?.data.initialCells;
  const state = value === 0 ? createDuel(initial, {matchId: match.id, moveLimit: match.state.moveLimit}) :
    events.find(e => e.type === 'round_committed' && e.data.state.round === value)?.data.state;
  if (!state) return;
  replayRound = value; renderMatch(); renderBoard('human', state.human); renderBoard('jev', state.jev);
  $('replay-round').textContent = String(value); $('round-label').textContent = `REPLAY · ROUND ${value}`;
  status(`Inspecting recorded round ${value}. Return to the live board before making a move.`);
}
async function exportData(kind) {
  if (!match) return;
  telemetry('export_requested');
  try {
    if (!imported && ['jsonl','rounds','candidates','cells'].includes(kind)) {
      const url = kind === 'jsonl' ? `/api/matches/${match.id}/bundle?format=jsonl` : `/api/matches/${match.id}/analytics?format=csv&table=${kind}`;
      const response = await fetch(url, {credentials: 'same-origin'});
      if (!response.ok) throw new Error('Export failed. The match must belong to your current session.');
      download(await response.blob(), `${match.id}-${kind}.${kind === 'jsonl' ? 'jsonl' : 'csv'}`); return;
    }
    const bundle = await getBundle();
    if (kind === 'bundle') download(new Blob([JSON.stringify(bundle, null, 2)], {type: 'application/json'}), `${match.id}-audit.json`);
    else if (kind === 'jsonl') download(new Blob([bundle.events.map(e => JSON.stringify(e)).join('\n') + '\n'], {type: 'application/x-ndjson'}), `${match.id}-events.jsonl`);
    else {
      const a = analyze(bundle);
      if (kind === 'analytics') download(new Blob([JSON.stringify(a, null, 2)], {type: 'application/json'}), `${match.id}-analytics.json`);
      else download(new Blob([csv({rounds: a.roundRows, candidates: a.candidateRows, cells: a.cellRows}[kind])], {type: 'text/csv'}), `${match.id}-${kind}.csv`);
    }
  } catch (error) { showError(error); }
}
function download(blob, name) {
  const url = URL.createObjectURL(blob), link = document.createElement('a'); link.href = url; link.download = name; link.click(); setTimeout(() => URL.revokeObjectURL(url), 10000);
}
async function verifyEvidence() {
  $('verify-audit').disabled = true; $('audit-status').textContent = 'Checking the complete event chain and replaying the recorded moves locally…';
  try {
    const bundle = await getBundle(), result = await verifyBundle(bundle, {expectedHead: bundle.head || null});
    $('audit-status').textContent = `Verified ${fmt(result.events)} events and ${fmt(result.rounds)} rounds. ` +
      (result.seedVerified ? 'Committed seed and every spawn verified. ' : 'The active seed is hidden; spawn provenance is not yet independently verified. ') +
      'No provider calls were made. This checks evidence consistency, not proof of unaided human play.';
  } catch (error) { $('audit-status').textContent = `Verification failed: ${error.message}`; showError(error); }
  finally { $('verify-audit').disabled = false; }
}
async function loadLeaderboard() {
  try {
    const data = await api(`/api/leaderboards?scope=${leaderScope}&difficulty=${$('difficulty').value}&period=${$('leader-period').value}&offset=${leaderOffset}`);
    nextLeaderOffset = data.nextOffset; $('leader-more').hidden = nextLeaderOffset === null;
    $('leader-table').replaceChildren(...(data.entries.length ? data.entries.map(entry => {
      const row = document.createElement('tr'); row.append(...[entry.rank, entry.display_name, fmt(entry.human_score), fmt(entry.jev_score), fmt(entry.max_tile), entry.outcome].map(cell)); return row;
    }) : [emptyRow(6, 'No verified scores in this cohort yet. Local practice never appears here.')]));
    $('leader-context').textContent = `${leaderScope.toUpperCase()} · ${$('difficulty').value.toUpperCase()} · ${data.period === 'week' ? 'THIS WEEK (UTC)' : 'ALL TIME'} · Equal scores share a rank. Best verified score per player.`;
  } catch (error) { $('leader-table').replaceChildren(emptyRow(6, error.message)); $('leader-more').hidden = true; }
}
async function refreshIdentity() {
  me = await api('/api/me');
  $('auth-button').textContent = me.user ? `${me.user.display_name} · Sign out` : 'Sign in with Discord';
  $('auth-button').disabled = !me.user && !me.capabilities.discord;
  $('auth-button').title = me.capabilities.discord ? 'Discord identity for verified score tracking' : 'The host must configure Discord credentials first.';
  $('opponent').querySelector('[value=jev]').disabled = !me.capabilities.jev;
  if (!me.capabilities.jev) $('opponent').value = 'local';
  renderHistory(); return me;
}
function renderHistory() {
  $('history-list').replaceChildren(...(me?.matches?.length ? me.matches.map(m => {
    const row = document.createElement('div'); row.className = 'history-row';
    const label = document.createElement('div'); label.textContent = `${m.mode === 'jev' ? 'JEV' : 'Local practice'} · ${fmt(m.humanScore)} — ${fmt(m.jevScore)}`;
    const small = document.createElement('small'); small.textContent = `${new Date(m.createdAt).toLocaleString()} · ${m.status} · ${m.ranked ? 'ranked' : 'unranked'}`; label.append(small);
    const button = document.createElement('button'); button.className = 'button small'; button.textContent = m.status === 'active' ? 'Resume' : 'Inspect';
    button.addEventListener('click', () => loadMatch(m.id).then(() => switchTab(m.status === 'active' ? 'decision' : 'replay')).catch(showError));
    row.append(label, button); return row;
  }) : [Object.assign(document.createElement('p'), {textContent: 'Your matches will appear here. Guest history is bound to this browser session.'})]));
}
async function switchTab(tab) {
  currentTab = tab;
  document.querySelectorAll('[data-tab]').forEach(button => { const active = button.dataset.tab === tab; button.classList.toggle('active', active); if (active) button.setAttribute('aria-current', 'page'); else button.removeAttribute('aria-current'); });
  for (const id of ['decision', 'analytics', 'replay', 'leaderboard', 'history']) $(id + '-panel').hidden = id !== tab;
  try {
    if (tab === 'analytics') { telemetry('analysis_opened'); await refreshAnalytics(); }
    if (tab === 'leaderboard') { leaderOffset = 0; await loadLeaderboard(); }
    if (tab === 'history') await refreshIdentity();
  } catch (error) { showError(error); }
}
function bind() {
  createBoard('human-board'); createBoard('jev-board');
  $('difficulty').value = store.get('difficulty', 'jev');
  if (!$('difficulty').value) $('difficulty').value = 'jev';
  $('telemetry-toggle').checked = telemetryEnabled;
  $('evidence-toggle').checked = store.get('evidence', 'true') === 'true';
  $('decision-content').hidden = !$('evidence-toggle').checked;
  $('new-game').addEventListener('click', () => { if (match?.status === 'active' && !imported) $('confirm-dialog').showModal(); else startMatch(); });
  $('confirm-new').addEventListener('click', () => { $('confirm-dialog').close(); startMatch(); });
  $('cancel-new').addEventListener('click', () => $('confirm-dialog').close());
  $('rules-button').addEventListener('click', () => $('rules-dialog').showModal());
  $('privacy-button').addEventListener('click', () => $('privacy-dialog').showModal());
  document.querySelectorAll('.dialog-close').forEach(button => button.addEventListener('click', () => button.closest('dialog').close()));
  document.querySelectorAll('[data-action]').forEach(button => button.addEventListener('click', () => { move(Number(button.dataset.action)); $('play-region').focus({preventScroll: true}); }));
  $('play-region').addEventListener('pointerdown', () => $('play-region').focus({preventScroll: true}));
  document.addEventListener('keydown', event => {
    if (event.ctrlKey || event.altKey || event.metaKey || event.repeat || event.target.closest('input,select,textarea,button,dialog') ||
        !$('play-region').contains(document.activeElement)) return;
    const action = {ArrowUp: 0, w: 0, W: 0, ArrowRight: 1, d: 1, D: 1, ArrowDown: 2, s: 2, S: 2, ArrowLeft: 3, a: 3, A: 3}[event.key];
    if (action !== undefined) { event.preventDefault(); move(action); }
  });
  let touchStart = null;
  $('human-board').addEventListener('pointerdown', event => { touchStart = {x: event.clientX, y: event.clientY, id: event.pointerId}; $('human-board').setPointerCapture(event.pointerId); });
  $('human-board').addEventListener('pointerup', event => {
    if (!touchStart || touchStart.id !== event.pointerId) return;
    const x = event.clientX - touchStart.x, y = event.clientY - touchStart.y; touchStart = null;
    if (Math.max(Math.abs(x), Math.abs(y)) < 25) return;
    move(Math.abs(x) > Math.abs(y) ? x > 0 ? 1 : 3 : y > 0 ? 2 : 0);
  });
  $('human-board').addEventListener('pointercancel', () => { touchStart = null; });
  $('retry').addEventListener('click', () => move(match.pending?.humanAction, true));
  $('fallback').addEventListener('click', async () => {
    if (!confirm('Switch this match to a local heuristic? It will permanently become unranked.')) return;
    try { match = (await api(`/api/matches/${match.id}/control`, {method: 'POST', body: {action: 'continue_practice'}})).match;
      await syncEvents(); clearError(); renderMatch(); if (match.pending) move(match.pending.humanAction, true);
    } catch (error) { showError(error); }
  });
  $('advance-jev').addEventListener('click', () => { autoOpponent = true; move(null); });
  document.querySelectorAll('[data-tab]').forEach(button => button.addEventListener('click', () => switchTab(button.dataset.tab)));
  $('evidence-toggle').addEventListener('change', () => { $('decision-content').hidden = !$('evidence-toggle').checked; store.set('evidence', String($('evidence-toggle').checked)); });
  $('telemetry-toggle').addEventListener('change', () => { telemetryEnabled = $('telemetry-toggle').checked; store.set('telemetry', String(telemetryEnabled)); if (!telemetryEnabled) telemetryQueue = []; });
  $('refresh-analytics').addEventListener('click', () => refreshAnalytics().catch(showError));
  $('export-summary').addEventListener('click', () => exportData('analytics'));
  $('heatmap-type').addEventListener('change', renderHeatmaps);
  $('replay-slider').addEventListener('input', () => inspectRound(Number($('replay-slider').value)));
  $('return-live').addEventListener('click', () => {
    if (imported && lastServerMatchId) loadMatch(lastServerMatchId).catch(showError);
    else if (imported) { imported = null; match = null; events = []; replayRound = null; renderMatch(); }
    else { replayRound = null; renderMatch(); }
  });
  $('verify-audit').addEventListener('click', verifyEvidence);
  document.querySelectorAll('[data-export]').forEach(button => button.addEventListener('click', () => exportData(button.dataset.export)));
  $('import-bundle').addEventListener('change', async event => {
    const file = event.target.files[0]; if (!file) return;
    try {
      if (file.size > 128 * 1024 * 1024) throw new Error('Import exceeds the 128 MB browser limit. Use the offline CLI verifier.');
      const bundle = JSON.parse(await file.text()); await verifyBundle(bundle);
      imported = bundle; events = bundle.events; match = {id: bundle.manifest.matchId, manifest: bundle.manifest,
        state: bundle.finalState, status: bundle.status || 'complete', mode: bundle.manifest.mode,
        ranked: false, verified: false, commitment: bundle.commitment, eventCount: events.length};
      analytics = null; replayRound = null; renderMatch(); renderDecision(); $('audit-status').textContent = 'Imported bundle passed consistency checks. This is an inspection, not an official score submission.';
    } catch (error) { showError(error); }
  });
  $('auth-button').addEventListener('click', async () => {
    if (me?.user) { await api('/api/logout', {method: 'POST', body: {}}); location.reload(); }
    else location.href = '/api/auth/discord';
  });
  document.querySelectorAll('[data-scope]').forEach(button => button.addEventListener('click', () => {
    leaderScope = button.dataset.scope; leaderOffset = 0; document.querySelectorAll('[data-scope]').forEach(b => b.classList.toggle('active', b === button)); loadLeaderboard();
  }));
  $('leader-period').addEventListener('change', () => { leaderOffset = 0; loadLeaderboard(); });
  $('leader-more').addEventListener('click', () => { leaderOffset = nextLeaderOffset || 0; loadLeaderboard(); });
  $('history-refresh').addEventListener('click', () => refreshIdentity().catch(showError));
  document.addEventListener('visibilitychange', () => telemetry('page_visibility', {visible: !document.hidden}));
  let lastFrame = performance.now(), lastReported = 0;
  function frame(now) {
    if (telemetryEnabled && !document.hidden && now - lastFrame > 120 && now - lastReported > 5000) {
      telemetry('frame_gap', {frameGapMs: now - lastFrame}); lastReported = now;
    }
    lastFrame = now; requestAnimationFrame(frame);
  }
  requestAnimationFrame(frame);
}
async function boot() {
  bind(); renderMatch();
  try {
    // Launch proof survives the OAuth round trip only in sessionStorage, not a referrer or server URL.
    const launch = new URLSearchParams(location.hash.slice(1)).get('launch');
    if (launch) { sessionStorage.setItem('jevLaunch', launch); history.replaceState(null, '', location.pathname); }
    await refreshIdentity();
    const pendingLaunch = sessionStorage.getItem('jevLaunch');
    if (pendingLaunch && me.user) {
      try { const response = await api('/api/context', {method: 'POST', body: {launchToken: pendingLaunch}}); me.context = response.context; }
      catch (error) { showError(error); }
      finally { sessionStorage.removeItem('jevLaunch'); }
    } else if (pendingLaunch) status('Sign in with the Discord account that launched this game to claim its channel context.');
    if (me.activeMatchId) await loadMatch(me.activeMatchId);
    else if (!me.capabilities.jev) await startMatch();
    else { renderMatch(); status('Live JEV is available. Select a difficulty and start your duel.'); }
  } catch (error) { showError(error); status('The game needs its included server. Start it with npm start, then reload this page.'); }
}
boot();
