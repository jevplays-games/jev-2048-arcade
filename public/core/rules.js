/** Pure, immutable 2048 rules. Tile cells contain exponents; 0 means empty. */
export const RULES_VERSION = 'duel-2048-v1';
export const ACTIONS = Object.freeze([0, 1, 2, 3]);
export const ACTION_NAMES = Object.freeze(['UP', 'RIGHT', 'DOWN', 'LEFT']);
export const MOVE_LIMIT = 2048;
export function validateCells(cells) {
  if (!Array.isArray(cells) || cells.length !== 16 ||
      cells.some(x => !Number.isInteger(x) || x < 0 || x > 30)) {
    throw new Error('Board must contain 16 integer exponents from 0 to 30.');
  }
}
export const tileValue = exponent => exponent ? 2 ** exponent : 0;
export const mass = cells => cells.reduce((n, e) => n + tileValue(e), 0);
export function lineIndices(action, line) {
  if (!ACTIONS.includes(action)) throw new Error('Invalid action.');
  return Array.from({length: 4}, (_, i) => action === 0 ? i * 4 + line :
    action === 1 ? line * 4 + 3 - i : action === 2 ? (3 - i) * 4 + line : line * 4 + i);
}
export function simulateMove(board, action) {
  const original = Array.isArray(board) ? board : board.cells;
  validateCells(original);
  if (!ACTIONS.includes(action)) throw new Error('Invalid action.');
  const cells = Array(16).fill(0), merges = [], movements = [];
  let scoreDelta = 0;
  for (let line = 0; line < 4; line++) {
    const indices = lineIndices(action, line);
    const items = indices.filter(i => original[i]).map(i => ({cell: i, exponent: original[i]}));
    let target = 0;
    for (let j = 0; j < items.length; j++) {
      const a = items[j], b = items[j + 1], to = indices[target++];
      if (b && a.exponent === b.exponent) {
        if (a.exponent >= 30) throw new Error('Tile exponent overflow.');
        cells[to] = a.exponent + 1;
        const value = tileValue(cells[to]);
        scoreDelta += value;
        merges.push({from: [a.cell, b.cell], to, exponent: cells[to], value});
        movements.push({from: a.cell, to}, {from: b.cell, to});
        j++;
      } else {
        cells[to] = a.exponent;
        movements.push({from: a.cell, to});
      }
    }
  }
  return {changed: cells.some((v, i) => v !== original[i]), cells, scoreDelta, merges, movements};
}
export function getLegalActions(board) {
  return ACTIONS.filter(action => simulateMove(board, action).changed);
}
export function applySpawn(board, event) {
  const original = Array.isArray(board) ? board : board.cells;
  validateCells(original);
  if (!Number.isInteger(event.cell) || event.cell < 0 || event.cell >= 16 ||
      original[event.cell] !== 0 || ![1, 2].includes(event.exponent)) throw new Error('Illegal spawn.');
  const cells = original.slice(); cells[event.cell] = event.exponent;
  return cells;
}
export function spawnFor(cells, event) {
  if (!event || !Array.isArray(event.order) || event.order.length !== 16 ||
      new Set(event.order).size !== 16 || event.order.some(i => !Number.isInteger(i) || i < 0 || i > 15) ||
      ![1, 2].includes(event.exponent)) throw new Error('Invalid spawn event.');
  const cell = event.order.find(i => cells[i] === 0);
  if (cell === undefined) throw new Error('No empty spawn cell.');
  return {cell, exponent: event.exponent};
}
export function makeBoard(cells) {
  validateCells(cells);
  return {cells: cells.slice(), score: 0, moves: 0, reached2048: cells.some(x => x >= 11),
    status: getLegalActions(cells).length ? 'playing' : 'blocked'};
}
export function createDuel(initialCells, options = {}) {
  const moveLimit = options.moveLimit ?? MOVE_LIMIT;
  if (!Number.isInteger(moveLimit) || moveLimit < 1 || moveLimit > MOVE_LIMIT) throw new Error('Invalid move cap.');
  return {game: '2048', rulesVersion: RULES_VERSION, matchId: options.matchId ?? 'local',
    revision: 0, round: 0, moveLimit, human: makeBoard(initialCells), jev: makeBoard(initialCells),
    status: 'active', winner: null};
}
export function advanceRound(state, {humanAction, jevAction, spawnEvent}) {
  if (state.status !== 'active') throw new Error('Match is finished.');
  const next = structuredClone(state), details = {};
  for (const actor of ['human', 'jev']) {
    const board = state[actor], action = actor === 'human' ? humanAction : jevAction;
    if (board.status !== 'playing') {
      if (action !== null) throw new Error('Finished board cannot move.');
      details[actor] = null;
      continue;
    }
    const moved = simulateMove(board, action);
    if (!moved.changed) throw new Error('Direction does not change the board.');
    const spawn = spawnFor(moved.cells, spawnEvent), cells = applySpawn(moved.cells, spawn);
    const moves = board.moves + 1;
    next[actor] = {cells, score: board.score + moved.scoreDelta, moves,
      reached2048: board.reached2048 || cells.some(x => x >= 11),
      status: !getLegalActions(cells).length ? 'blocked' : moves >= state.moveLimit ? 'move_cap' : 'playing'};
    details[actor] = {...moved, spawn};
  }
  next.round++; next.revision++;
  if (next.human.status !== 'playing' && next.jev.status !== 'playing') {
    next.status = 'complete';
    next.winner = next.human.score > next.jev.score ? 'human' : next.human.score < next.jev.score ? 'jev' : 'draw';
  }
  return {state: next, details};
}
export function canonical(value) {
  if (value === null || typeof value !== 'object') {
    if (typeof value === 'number' && !Number.isFinite(value)) throw new Error('Nonfinite canonical value.');
    if (value === undefined) throw new Error('Undefined canonical value.');
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return '[' + value.map(canonical).join(',') + ']';
  return '{' + Object.keys(value).sort().map(k => JSON.stringify(k) + ':' + canonical(value[k])).join(',') + '}';
}
export function serializeState(state) { return canonical(state); }
export function deserializeState(json) {
  const s = JSON.parse(json);
  if (s.rulesVersion !== RULES_VERSION) throw new Error('Unsupported rules version.');
  validateCells(s.human.cells); validateCells(s.jev.cells);
  return s;
}
