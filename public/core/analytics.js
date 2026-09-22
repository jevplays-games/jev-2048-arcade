import {ACTION_NAMES, tileValue} from './rules.js';
import {boardFeatures} from './evaluate.js';
export const ANALYTICS_VERSION = 'analytics-v1';
export const average = a => a.length ? a.reduce((s, v) => s + v, 0) / a.length : null;
export function quantile(values, q) {
  if (!values.length) return null;
  const sorted = values.slice().sort((a, b) => a - b), at = (sorted.length - 1) * q;
  return sorted[Math.floor(at)] + (sorted[Math.ceil(at)] - sorted[Math.floor(at)]) * (at % 1);
}
export function distribution(values) {
  const a = values.filter(Number.isFinite);
  return {count: a.length, min: a.length ? Math.min(...a) : null, max: a.length ? Math.max(...a) : null,
    mean: average(a), p50: quantile(a, .5), p90: quantile(a, .9), p95: quantile(a, .95), p99: quantile(a, .99)};
}
function makeActor() {
  return {moves: 0, finalScore: 0, maxTile: 0, scoreGains: [], emptyCells: [], legalCounts: [],
    monotonicity: [], roughness: [], entropy: [], mergeCount: 0, mergedTileHistogram: {},
    mergeDestinations: Array(16).fill(0), spawnPositions: Array(16).fill(0),
    occupiedSnapshots: Array(16).fill(0), tileValueSum: Array(16).fill(0), maxTilePositions: Array(16).fill(0),
    spawn2: 0, spawn4: 0, actions: [0, 0, 0, 0], transitions: Array.from({length: 4}, () => Array(4).fill(0)),
    reversals: 0, lastAction: null, movesWithoutMerge: 0, longestNoMergeStreak: 0, currentNoMergeStreak: 0,
    cornerHeldMoves: 0, milestones: {}, heuristicRegret: [], heuristicAgreement: 0, heuristicCompared: 0,
    terminalStatus: 'playing'};
}
/** Derived metrics only. Never influences gameplay or model calls. Null means not measured. */
export function analyze(bundle) {
  const events = bundle.events || [], rounds = events.filter(e => e.type === 'round_committed');
  const actors = {human: makeActor(), jev: makeActor()}, series = [], candidateRows = [], cellRows = [], roundRows = [];
  const counts = {}, sources = {}, httpStatuses = {}, latency = [], providerLatency = [], featureLatency = [], confidence = [], margin = [],
    questionEntropy = [], questionConfidence = [], jsDisagreement = [], serverLatency = [], analyticsLatency = [];
  let inputTokens = 0, outputTokens = 0, inputKnown = 0, outputKnown = 0, usageKnown = 0, usageUnknown = 0, retries = 0, nodeTotal = 0, truncations = 0;
  const attemptsByRequest = new Map();
  for (const e of events) {
    counts[e.type] = (counts[e.type] || 0) + 1;
    if (e.type === 'jev_requested') {
      const key = `${e.data.requestHash}:${e.seq}`;
      attemptsByRequest.set(key, false);
      if (e.data.attempt > 1) retries++;
    }
    if (e.type === 'jev_response') {
      httpStatuses[e.data.httpStatus] = (httpStatuses[e.data.httpStatus] || 0) + 1;
      if (Number.isFinite(e.data.latencyMs)) providerLatency.push(e.data.latencyMs);
      const usage = e.data.response?.usage;
      const candidates = [...attemptsByRequest.keys()].reverse();
      const key = candidates.find(k => k.startsWith(e.data.requestHash + ':') && !attemptsByRequest.get(k));
      if (key) attemptsByRequest.set(key, true);
      const hasInput = Number.isSafeInteger(usage?.input_tokens) && usage.input_tokens >= 0;
      const hasOutput = Number.isSafeInteger(usage?.output_tokens) && usage.output_tokens >= 0;
      if (hasInput) { inputTokens += usage.input_tokens; inputKnown++; }
      if (hasOutput) { outputTokens += usage.output_tokens; outputKnown++; }
      if (hasInput && hasOutput) usageKnown++; else usageUnknown++;
    }
  }
  usageUnknown += [...attemptsByRequest.values()].filter(found => !found).length;
  for (const event of rounds) {
    const d = event.data, state = d.state, decision = d.decision;
    if (Number.isFinite(d.timings?.roundServerMs)) serverLatency.push(d.timings.roundServerMs);
    if (Number.isFinite(d.timings?.analyticsMs)) analyticsLatency.push(d.timings.analyticsMs);
    const point = {round: state.round, humanScore: state.human.score, jevScore: state.jev.score,
      scoreDifference: state.human.score - state.jev.score, decisionMs: decision.latencyMs ?? null,
      confidence: decision.confidence ?? null, source: decision.source};
    sources[decision.source] = (sources[decision.source] || 0) + 1;
    if (Number.isFinite(decision.latencyMs)) latency.push(decision.latencyMs);
    if (Number.isFinite(decision.featureMs)) featureLatency.push(decision.featureMs);
    if (Number.isFinite(decision.confidence)) confidence.push(decision.confidence);
    if (Number.isFinite(decision.utilityMargin)) margin.push(decision.utilityMargin);
    const candidates = decision.candidates || [];
    nodeTotal += candidates.reduce((s, c) => s + (c.lookahead?.nodes || 0), 0);
    truncations += candidates.filter(c => c.lookahead?.truncated).length;
    for (const c of candidates) {
      const row = {matchId: state.matchId, round: state.round, action: c.name, selected: c.action === decision.action,
        source: decision.source, mergeGain: c.mergeGain, emptyCount: c.features.emptyCount,
        legalCount: c.features.legalCount, maxTile: c.features.maxTile, maxInCorner: c.features.maxInCorner,
        monotonicity: c.features.monotonicity, roughness: c.features.roughness,
        immediateBlockProbability: c.features.immediateBlockProbability, expectedLegalMoves: c.features.expectedLegalMoves,
        baselineUtility: c.baselineUtility, modelUtility: c.utility ?? null, confidence: c.confidence ?? null,
        searchValue: c.lookahead.value, nodes: c.lookahead.nodes, nodeBudget: c.lookahead.nodeBudget,
        requestedDepth: c.lookahead.requestedDepth, maxDepthReached: c.lookahead.maxDepthReached,
        frontierEvaluations: c.lookahead.frontierEvaluations, searchTruncated: c.lookahead.truncated,
        adjacentEquals: c.features.adjacentEquals, tileEntropyBits: c.features.tileEntropyBits};
      for (const [dim, answer] of Object.entries(c.dimensions || {})) {
        row[dim + 'Score'] = answer.score; row[dim + 'Confidence'] = answer.confidence;
        const ps = Object.values(answer.probabilities);
        const entropy = -ps.reduce((s, p) => s + (p ? p * Math.log2(p) : 0), 0);
        row[dim + 'EntropyBits'] = entropy; questionEntropy.push(entropy); questionConfidence.push(answer.confidence);
        for (const [level, probability] of Object.entries(answer.probabilities)) row[`${dim}P${level}`] = probability;
      }
      candidateRows.push(row);
    }
    if (candidates.length && decision.source === 'jev') {
      const bestBaseline = candidates.slice().sort((a, b) => b.baselineUtility - a.baselineUtility || a.action - b.action)[0];
      jsDisagreement.push(Number(bestBaseline.action !== decision.action));
    }
    for (const actor of ['human', 'jev']) {
      const b = state[actor], a = actors[actor], details = d.details[actor], f = boardFeatures(b);
      point[actor + 'Empty'] = f.emptyCount; point[actor + 'Legal'] = f.legalCount;
      point[actor + 'MaxTile'] = f.maxTile;
      a.finalScore = b.score; a.maxTile = f.maxTile; a.terminalStatus = b.status;
      if (!details) continue;
      const action = d.actions[actor];
      a.moves++; a.scoreGains.push(details.scoreDelta); a.emptyCells.push(f.emptyCount); a.legalCounts.push(f.legalCount);
      a.monotonicity.push(f.monotonicity); a.roughness.push(f.roughness); a.entropy.push(f.tileEntropyBits);
      a.actions[action]++; a.mergeCount += details.merges.length;
      if (a.lastAction !== null) {
        a.transitions[a.lastAction][action]++;
        if ((a.lastAction + 2) % 4 === action) a.reversals++;
      }
      a.lastAction = action;
      if (!details.merges.length) { a.movesWithoutMerge++; a.currentNoMergeStreak++; }
      else a.currentNoMergeStreak = 0;
      a.longestNoMergeStreak = Math.max(a.longestNoMergeStreak, a.currentNoMergeStreak);
      if (f.maxInCorner) a.cornerHeldMoves++;
      for (const merge of details.merges) {
        a.mergeDestinations[merge.to]++; a.mergedTileHistogram[merge.value] = (a.mergedTileHistogram[merge.value] || 0) + 1;
      }
      a.spawnPositions[details.spawn.cell]++;
      if (details.spawn.exponent === 1) a.spawn2++; else a.spawn4++;
      for (let exponent = 3; exponent <= f.maxExponent; exponent++) {
        if (!a.milestones[2 ** exponent]) a.milestones[2 ** exponent] = {move: b.moves, round: state.round, score: b.score};
      }
      for (let i = 0; i < 16; i++) {
        if (b.cells[i]) a.occupiedSnapshots[i]++;
        a.tileValueSum[i] += tileValue(b.cells[i]);
        if (b.cells[i] === f.maxExponent) a.maxTilePositions[i]++;
        cellRows.push({matchId: state.matchId, round: state.round, actor, cell: i, row: Math.floor(i / 4),
          column: i % 4, exponent: b.cells[i], value: tileValue(b.cells[i]),
          spawned: i === details.spawn.cell, mergeCount: details.merges.filter(m => m.to === i).length});
      }
      const comparison = actor === 'human' ? d.humanCandidates || [] : candidates;
      const selected = comparison.find(c => c.action === action);
      if (selected && comparison.length > 1) {
        const best = comparison.slice().sort((x, y) => y.baselineUtility - x.baselineUtility || x.action - y.action)[0];
        a.heuristicCompared++; a.heuristicAgreement += Number(action === best.action);
        a.heuristicRegret.push(Math.max(0, best.baselineUtility - selected.baselineUtility));
      }
      roundRows.push({matchId: state.matchId, round: state.round, actor, action: ACTION_NAMES[action], score: b.score,
        scoreGain: details.scoreDelta, merges: details.merges.length, maxTile: f.maxTile, emptyCount: f.emptyCount,
        legalCount: f.legalCount, monotonicity: f.monotonicity, roughness: f.roughness, entropyBits: f.tileEntropyBits,
        spawnCell: details.spawn.cell, spawnValue: tileValue(details.spawn.exponent), status: b.status,
        decisionSource: actor === 'jev' ? decision.source : 'human',
        decisionMs: actor === 'jev' ? decision.latencyMs ?? null : null,
        scorePerMove: b.score / b.moves, eventSeq: event.seq, eventHash: event.hash});
    }
    series.push(point);
  }
  for (const a of Object.values(actors)) {
    a.scorePerMove = a.moves ? a.finalScore / a.moves : null;
    a.mergeMoveRate = a.moves ? (a.moves - a.movesWithoutMerge) / a.moves : null;
    a.cornerHoldRate = a.moves ? a.cornerHeldMoves / a.moves : null;
    a.reversalRate = a.moves > 1 ? a.reversals / (a.moves - 1) : null;
    a.scoreGainDistribution = distribution(a.scoreGains); a.emptyDistribution = distribution(a.emptyCells);
    a.legalDistribution = distribution(a.legalCounts); a.monotonicityDistribution = distribution(a.monotonicity);
    a.roughnessDistribution = distribution(a.roughness); a.entropyDistribution = distribution(a.entropy);
    a.heuristicRegretDistribution = distribution(a.heuristicRegret);
    a.heuristicAgreementRate = a.heuristicCompared ? a.heuristicAgreement / a.heuristicCompared : null;
    a.meanTileValue = a.tileValueSum.map(n => a.moves ? n / a.moves : null);
    a.occupancyRate = a.occupiedSnapshots.map(n => a.moves ? n / a.moves : null);
  }
  const telemetry = bundle.telemetry || [];
  const clientTypes = {}, inputDurations = [], rtt = [], frameGaps = [];
  for (const e of telemetry) {
    clientTypes[e.type] = (clientTypes[e.type] || 0) + 1;
    if (Number.isFinite(e.data?.thinkMs)) inputDurations.push(e.data.thinkMs);
    if (Number.isFinite(e.data?.rttMs)) rtt.push(e.data.rttMs);
    if (Number.isFinite(e.data?.frameGapMs)) frameGaps.push(e.data.frameGapMs);
  }
  return {schemaVersion: ANALYTICS_VERSION, evidenceClass: bundle.manifest?.evidenceClass || 'server-recorded',
    matchId: bundle.manifest?.matchId || null, manifest: bundle.manifest, rounds: rounds.length,
    eventCounts: counts, eventHead: events.at(-1)?.hash ?? null, eventCount: events.length,
    observedWallMs: events.length > 1 ? Date.parse(events.at(-1).occurredAt) - Date.parse(events[0].occurredAt) : 0,
    performance: {roundServerMs: distribution(serverLatency), analyticsOverheadMs: distribution(analyticsLatency)},
    actors, series, roundRows, candidateRows, cellRows,
    model: {sources, requests: counts.jev_requested || 0, failures: counts.jev_failed || 0, retries,
      httpStatuses, failedHttpResponses: Object.entries(httpStatuses).reduce((n, [code, count]) => n + (Number(code) >= 400 ? count : 0), 0),
      invalidResponseEvents: events.filter(e => e.type === 'jev_failed' && e.data.code === 'jev_invalid').length,
      resumedRounds: counts.round_resumed || 0,
      decisions: sources.jev || 0, forced: sources.forced || 0, heuristic: sources.heuristic || 0,
      decisionLatencyMs: distribution(latency), providerLatencyMs: distribution(providerLatency),
      featureLatencyMs: distribution(featureLatency), confidence: distribution(confidence),
      questionConfidence: distribution(questionConfidence), questionEntropyBits: distribution(questionEntropy),
      utilityMargin: distribution(margin), heuristicDisagreementRate: average(jsDisagreement),
      searchNodes: nodeTotal, truncatedCandidates: truncations,
      usage: {inputTokensKnown: inputTokens, outputTokensKnown: outputTokens, attemptsWithUsage: usageKnown,
        attemptsWithoutUsage: usageUnknown, attemptsWithKnownInput: inputKnown, attemptsWithKnownOutput: outputKnown, complete: usageUnknown === 0},
      estimatedCostUSD: null},
    client: {trust: 'untrusted-opt-in', counts: clientTypes, thinkTimeMs: distribution(inputDurations),
      roundTripMs: distribution(rtt), frameGapMs: distribution(frameGaps)},
    integrity: {checked: false, note: 'Run verifyBundle to check the chain and replay; a stored hash alone is not verification.'},
    caveats: ['Rubric confidence is not a win probability.', 'Heuristic regret is a proxy, not optimal-play regret.',
      'Human and JEV baseline comparisons use their recorded, possibly different, search budgets.',
      'Unknown token usage is not zero. Cost is unset unless an explicit dated tariff is supplied.',
      'Browser timing is opt-in and untrusted. No hidden reasoning is recorded.',
      'Hash chaining is tamper-evident relative to a trusted head; it is not operator-proof.']};
}
export function csv(rows) {
  const keys = [...new Set(rows.flatMap(Object.keys))];
  function field(v) {
    if (v === undefined || v === null) return '';
    let s = typeof v === 'object' ? JSON.stringify(v) : String(v);
    // Prevent spreadsheet formula injection in untrusted textual fields.
    if (typeof v === 'string' && /^[=+\-@\t\r]/.test(s)) s = "'" + s;
    return '"' + s.replaceAll('"', '""') + '"';
  }
  return [keys.map(field).join(','), ...rows.map(r => keys.map(k => field(r[k])).join(','))].join('\n') + '\n';
}
