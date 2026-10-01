import {ACTIONS, ACTION_NAMES, getLegalActions, simulateMove, tileValue} from './rules.js';
export const POLICY_VERSION = '2048-factorized-v1';
export const PROFILES = Object.freeze({
  easy: {dimensions: ['merge'], weights: [1], depth: 0, nodes: 0},
  normal: {dimensions: ['merge', 'space'], weights: [.6, .4], depth: 1, nodes: 512},
  hard: {dimensions: ['merge', 'space', 'anchor'], weights: [.5, .3, .2], depth: 2, nodes: 4096},
  jev: {dimensions: ['merge', 'space', 'anchor'], weights: [.5, .3, .2], depth: 3, nodes: 16384}
});
export function boardFeatures(board) {
  const cells = Array.isArray(board) ? board : board.cells;
  const maxExponent = Math.max(...cells), occupied = cells.filter(Boolean), counts = {};
  let roughness = 0, monotonicPenalty = 0, adjacentEquals = 0;
  for (let i = 0; i < 16; i++) {
    if (cells[i]) counts[cells[i]] = (counts[cells[i]] || 0) + 1;
    for (const j of [i % 4 < 3 ? i + 1 : -1, i < 12 ? i + 4 : -1]) {
      if (j >= 0 && cells[i] && cells[j]) {
        roughness += Math.abs(cells[i] - cells[j]);
        if (cells[i] === cells[j]) adjacentEquals++;
      }
    }
  }
  for (let axis = 0; axis < 2; axis++) for (let k = 0; k < 4; k++) {
    const line = Array.from({length: 4}, (_, i) => cells[axis ? i * 4 + k : k * 4 + i]);
    let inc = 0, dec = 0;
    for (let i = 0; i < 3; i++) { const d = line[i + 1] - line[i]; inc += Math.max(0, d); dec += Math.max(0, -d); }
    monotonicPenalty += Math.min(inc, dec);
  }
  const entropy = occupied.length ? -Object.values(counts).reduce((s, n) => {
    const p = n / occupied.length; return s + p * Math.log2(p);
  }, 0) : 0;
  return {emptyCount: 16 - occupied.length, occupiedCount: occupied.length, maxExponent,
    maxTile: tileValue(maxExponent), maxInCorner: maxExponent > 0 && [0, 3, 12, 15].some(i => cells[i] === maxExponent),
    maxPositions: cells.flatMap((v, i) => v && v === maxExponent ? [i] : []),
    roughness: roughness / (24 * Math.max(1, maxExponent)),
    monotonicity: 1 - monotonicPenalty / (24 * Math.max(1, maxExponent)),
    adjacentEquals, tileEntropyBits: entropy, tileHistogram: counts,
    legalCount: getLegalActions(cells).length, mass: occupied.reduce((s, e) => s + tileValue(e), 0)};
}
export function heuristic(cells) {
  const f = boardFeatures(cells);
  return f.legalCount ? 4 * f.emptyCount / 16 + f.monotonicity + Number(f.maxInCorner) - f.roughness : -10;
}
export function chanceOutcomes(cells) {
  const empty = cells.flatMap((e, i) => e ? [] : [i]);
  if (!empty.length) return [{cells: cells.slice(), probability: 1, cell: null, exponent: null}];
  return empty.flatMap(cell => [1, 2].map(exponent => {
    const spawned = cells.slice(); spawned[cell] = exponent;
    return {cells: spawned, probability: (exponent === 1 ? .9 : .1) / empty.length, cell, exponent};
  }));
}
export function spawnRisk(cells) {
  let immediateBlockProbability = 0, expectedLegalMoves = 0, expectedEmptyCount = 0;
  for (const outcome of chanceOutcomes(cells)) {
    const legal = getLegalActions(outcome.cells).length;
    if (!legal) immediateBlockProbability += outcome.probability;
    expectedLegalMoves += outcome.probability * legal;
    expectedEmptyCount += outcome.probability * outcome.cells.filter(e => !e).length;
  }
  return {immediateBlockProbability, expectedLegalMoves, expectedEmptyCount};
}
/** Deterministic bounded expectimax. Exhausted branches retain all chance mass via frontier evaluation. */
export function lookaheadReference(afterstate, depth, budget) {
  const stats = {nodes: 0, frontierEvaluations: 0, maxDepthReached: 0, truncated: false};
  function decision(cells, remaining, traversed) {
    stats.maxDepthReached = Math.max(stats.maxDepthReached, traversed);
    if (stats.nodes >= budget) {
      if (remaining > 0) stats.truncated = true;
      stats.frontierEvaluations++; return heuristic(cells);
    }
    stats.nodes++;
    if (remaining === 0) { stats.frontierEvaluations++; return heuristic(cells); }
    const legal = getLegalActions(cells);
    if (!legal.length) return -10;
    let best = -Infinity;
    for (const action of legal) {
      const move = simulateMove(cells, action);
      const reward = Math.log2(1 + move.scoreDelta) / 32;
      best = Math.max(best, reward + chance(move.cells, remaining - 1, traversed + 1));
    }
    return best;
  }
  function chance(cells, remaining, traversed) {
    return chanceOutcomes(cells).reduce((value, outcome) =>
      value + outcome.probability * decision(outcome.cells, remaining, traversed), 0);
  }
  const value = depth ? chance(afterstate, depth, 0) : heuristic(afterstate);
  return {value, requestedDepth: depth, nodeBudget: budget, ...stats};
}
/* Fast bounded expectimax: same traversal order, node accounting and floating-point operation order as
   lookaheadReference, but in place on typed arrays with no per-node allocation. */
const LINE = new Int8Array(64); // [action * 16 + line * 4 + i] -> cell index, as lineIndices()
for (let a = 0; a < 4; a++) for (let l = 0; l < 4; l++) for (let i = 0; i < 4; i++)
  LINE[a * 16 + l * 4 + i] = a === 0 ? i * 4 + l : a === 1 ? l * 4 + 3 - i : a === 2 ? (3 - i) * 4 + l : l * 4 + i;
const POW2 = Float64Array.from({length: 32}, (_, i) => 2 ** i);
let movedScore = 0;
/** Writes the move of src into dst; returns whether it changed the board and leaves the score in movedScore. */
function moveInto(src, dst, action) {
  dst.fill(0);
  let score = 0, changed = false;
  for (let line = 0; line < 4; line++) {
    const base = action * 16 + line * 4;
    let pend = 0, t = 0;
    for (let i = 0; i < 4; i++) {
      const v = src[LINE[base + i]];
      if (!v) continue;
      if (pend === 0) { pend = v; continue; }
      if (pend === v) {
        if (v >= 30) throw new Error('Tile exponent overflow.');
        const out = v + 1; score += POW2[out]; dst[LINE[base + t++]] = out; pend = 0;
      } else { dst[LINE[base + t++]] = pend; pend = v; }
    }
    if (pend) dst[LINE[base + t++]] = pend;
  }
  for (let i = 0; i < 16; i++) if (dst[i] !== src[i]) { changed = true; break; }
  movedScore = score;
  return changed;
}
function anyMove(c) {
  let empty = 0;
  for (let i = 0; i < 16; i++) if (!c[i]) empty++;
  if (empty) return empty < 16;
  for (let i = 0; i < 16; i++) {
    if (i % 4 < 3 && c[i] === c[i + 1]) return true;
    if (i < 12 && c[i] === c[i + 4]) return true;
  }
  return false;
}
function heuristicFast(c) {
  if (!anyMove(c)) return -10;
  let empty = 0, maxExp = 0, rough = 0;
  for (let i = 0; i < 16; i++) {
    const v = c[i];
    if (!v) { empty++; continue; }
    if (v > maxExp) maxExp = v;
    if (i % 4 < 3) { const w = c[i + 1]; if (w) rough += v > w ? v - w : w - v; }
    if (i < 12) { const w = c[i + 4]; if (w) rough += v > w ? v - w : w - v; }
  }
  let pen = 0;
  for (let k = 0; k < 4; k++) {
    let inc = 0, dec = 0, d;
    d = c[k * 4 + 1] - c[k * 4]; if (d > 0) inc += d; else dec -= d;
    d = c[k * 4 + 2] - c[k * 4 + 1]; if (d > 0) inc += d; else dec -= d;
    d = c[k * 4 + 3] - c[k * 4 + 2]; if (d > 0) inc += d; else dec -= d;
    pen += inc < dec ? inc : dec;
    inc = 0; dec = 0;
    d = c[4 + k] - c[k]; if (d > 0) inc += d; else dec -= d;
    d = c[8 + k] - c[4 + k]; if (d > 0) inc += d; else dec -= d;
    d = c[12 + k] - c[8 + k]; if (d > 0) inc += d; else dec -= d;
    pen += inc < dec ? inc : dec;
  }
  const scale = 24 * Math.max(1, maxExp), corner = maxExp > 0 && (c[0] === maxExp || c[3] === maxExp || c[12] === maxExp || c[15] === maxExp);
  return 4 * empty / 16 + (1 - pen / scale) + Number(corner) - rough / scale;
}
const levelBuffers = [];
const levelBuf = depth => levelBuffers[depth] ??= {moved: new Uint8Array(16), cells: new Uint8Array(16)};
export function lookahead(afterstate, depth, budget) {
  const stats = {nodes: 0, frontierEvaluations: 0, maxDepthReached: 0, truncated: false};
  function decision(c, remaining, traversed) {
    if (traversed > stats.maxDepthReached) stats.maxDepthReached = traversed;
    if (stats.nodes >= budget) {
      if (remaining > 0) stats.truncated = true;
      stats.frontierEvaluations++; return heuristicFast(c);
    }
    stats.nodes++;
    if (remaining === 0) { stats.frontierEvaluations++; return heuristicFast(c); }
    const buf = levelBuf(traversed);
    let best = -Infinity, any = false;
    for (let action = 0; action < 4; action++) {
      if (!moveInto(c, buf.moved, action)) continue;
      any = true;
      const reward = Math.log2(1 + movedScore) / 32;
      best = Math.max(best, reward + chance(buf.moved, buf.cells, remaining - 1, traversed + 1));
    }
    return any ? best : -10;
  }
  function chance(moved, work, remaining, traversed) {
    let n = 0;
    for (let i = 0; i < 16; i++) if (!moved[i]) n++;
    if (!n) { work.set(moved); return 0 + decision(work, remaining, traversed); }
    work.set(moved);
    let value = 0;
    for (let i = 0; i < 16; i++) {
      if (moved[i]) continue;
      work[i] = 1; value = value + (.9 / n) * decision(work, remaining, traversed);
      work[i] = 2; value = value + (.1 / n) * decision(work, remaining, traversed);
      work[i] = 0;
    }
    return value;
  }
  const start = Uint8Array.from(afterstate);
  const value = depth ? chance(start, new Uint8Array(16), depth, 0) : heuristicFast(start);
  return {value, requestedDepth: depth, nodeBudget: budget, ...stats};
}
export function generateCandidates(board, difficulty = 'normal') { return generateCandidatesWith(board, difficulty, lookahead); }
export function generateCandidatesReference(board, difficulty = 'normal') { return generateCandidatesWith(board, difficulty, lookaheadReference); }
function generateCandidatesWith(board, difficulty, lookahead) {
  const profile = PROFILES[difficulty]; if (!profile) throw new Error('Unknown difficulty.');
  const legal = getLegalActions(board);
  return legal.map(action => {
    const move = simulateMove(board, action), features = boardFeatures(move.cells), risk = spawnRisk(move.cells);
    const search = lookahead(move.cells, profile.depth, Math.floor(profile.nodes / Math.max(1, legal.length)));
    return {action, name: ACTION_NAMES[action], afterstate: move.cells, mergeGain: move.scoreDelta,
      merges: move.merges, features: {...features, ...risk}, lookahead: search,
      baselineUtility: search.value + Math.log2(1 + move.scoreDelta) / 32 - 2 * risk.immediateBlockProbability};
  });
}
export function fallbackDecision(candidates) {
  if (!candidates.length) return null;
  const ranked = candidates.slice().sort((a, b) =>
    a.features.immediateBlockProbability - b.features.immediateBlockProbability ||
    b.features.emptyCount - a.features.emptyCount ||
    b.features.expectedLegalMoves - a.features.expectedLegalMoves ||
    Number(b.features.maxInCorner) - Number(a.features.maxInCorner) ||
    a.features.roughness - b.features.roughness || b.mergeGain - a.mergeGain || a.action - b.action);
  return ranked[0].action;
}
export function baselineAction(board, policy = 'heuristic', random = Math.random) {
  const legal = getLegalActions(board); if (!legal.length) return null;
  if (policy === 'random') return legal[Math.floor(random() * legal.length)];
  if (policy === 'greedy') return legal.slice().sort((a, b) =>
    simulateMove(board, b).scoreDelta - simulateMove(board, a).scoreDelta || a - b)[0];
  const candidates = generateCandidates(board, policy === 'expectimax' ? 'normal' : 'easy');
  return candidates.slice().sort((a, b) => b.baselineUtility - a.baselineUtility || a.action - b.action)[0].action;
}
