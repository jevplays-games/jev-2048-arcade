import test from 'node:test';
import assert from 'node:assert/strict';
import {simulateMove, simulateMoveReference, getLegalActions, getLegalActionsReference, canonical, canonicalReference} from '../public/core/rules.js';
import {hex, hexReference} from '../public/core/crypto.js';
import {lookahead, lookaheadReference, generateCandidates, generateCandidatesReference, PROFILES} from '../public/core/evaluate.js';

// Optimized hot paths must be indistinguishable from the original implementations kept as *Reference exports.
function rng(seed) {
  let s = seed >>> 0;
  return () => { s = (s + 0x6D2B79F5) >>> 0; let t = s; t = Math.imul(t ^ t >>> 15, t | 1); t ^= t + Math.imul(t ^ t >>> 7, t | 61); return ((t ^ t >>> 14) >>> 0) / 4294967296; };
}
function spawn(cells, r) {
  const empty = []; cells.forEach((v, i) => { if (!v) empty.push(i); });
  if (empty.length) cells[empty[Math.floor(r() * empty.length)]] = r() < .9 ? 1 : 2;
}
/** Boards reached by random play, so they have realistic structure, plus the occasional blocked board. */
function playedBoards(count, seed) {
  const r = rng(seed), out = [];
  while (out.length < count) {
    let cells = Array(16).fill(0); spawn(cells, r); spawn(cells, r);
    for (let step = 0, length = Math.floor(r() * 500); step < length && out.length < count; step++) {
      const legal = getLegalActionsReference(cells);
      if (!legal.length) { out.push(cells.slice()); break; }
      if (r() < .05) out.push(cells.slice());
      cells = simulateMoveReference(cells, legal[Math.floor(r() * legal.length)]).cells; spawn(cells, r);
    }
  }
  return out;
}
/** Arbitrary boards, including sparse ones and ones that merge the maximum exponent. */
function wildBoards(count, seed) {
  const r = rng(seed);
  return Array.from({length: count}, () => {
    const density = r(), top = 1 + Math.floor(r() * 14);
    return Array.from({length: 16}, () => r() < density ? 1 + Math.floor(r() * top) : 0);
  });
}
const same = (a, b) => assert.deepEqual(a, b) || assert.equal(JSON.stringify(a), JSON.stringify(b));
function outcome(fn) { try { return {value: fn()}; } catch (error) { return {error: error.message}; } }

test('simulateMove and getLegalActions match the reference, including errors', () => {
  const boards = [...playedBoards(300, 1), ...wildBoards(1500, 2),
    Array(16).fill(0), Array(16).fill(1), Array(16).fill(30), [30, 30, ...Array(14).fill(0)], Array(16).fill(31), Array(15).fill(0).concat(-1)];
  let compared = 0;
  for (const board of boards) {
    for (let action = -1; action <= 4; action++) { same(outcome(() => simulateMove(board, action)), outcome(() => simulateMoveReference(board, action))); compared++; }
    same(outcome(() => getLegalActions(board)), outcome(() => getLegalActionsReference(board))); compared++;
    same(outcome(() => getLegalActions({cells: board})), outcome(() => getLegalActionsReference({cells: board})));
  }
  assert.ok(compared > 10000);
});

function randomValue(r, depth = 0) {
  const kind = Math.floor(r() * (depth > 3 ? 6 : 9));
  const pick = a => a[Math.floor(r() * a.length)];
  switch (kind) {
    case 0: return null;
    case 1: return r() < .5;
    case 2: return pick([0, -0, 1, -1, 1.5, 1e21, 1e-7, 123456789.125, Number.MAX_SAFE_INTEGER, 0.1 + 0.2]);
    case 3: case 4: return pick(['', 'a', 'UP_merge', 'quote"back\\slash', 'new\nline', ' ', 'café', '😀', '\ud800', '0', '10', '9']);
    case 5: return Math.floor(r() * 100);
    case 6: case 7: return Array.from({length: Math.floor(r() * 5)}, () => randomValue(r, depth + 1));
    default: {
      const o = {};
      for (let i = 0, n = Math.floor(r() * 6); i < n; i++) o[pick(['b', 'a', 'z', '10', '9', '2', 'A', 'é', 'key with space', 'q"', 'data', 'hash', 'UP_merge'])] = randomValue(r, depth + 1);
      return o;
    }
  }
}
test('canonical matches the reference serializer', () => {
  const r = rng(3);
  for (let i = 0; i < 4000; i++) { const v = randomValue(r); assert.equal(canonical(v), canonicalReference(v)); }
  for (const bad of [undefined, NaN, Infinity, [1, undefined], {a: undefined}, {a: [NaN]}]) same(outcome(() => canonical(bad)), outcome(() => canonicalReference(bad)));
  const odd = [[1, , 2], [, ,], [() => 1, 2], {f() {}, g: 1}, new Date(0), Object.create(null), new Uint8Array(12), 'x', 7, true, null];
  for (const v of odd) same(outcome(() => canonical(v)), outcome(() => canonicalReference(v)));
  for (const board of playedBoards(50, 4)) assert.equal(canonical({cells: board, nested: {board}}), canonicalReference({cells: board, nested: {board}}));
});

test('lookahead matches the reference value and every statistic', () => {
  const boards = [...playedBoards(150, 5), ...wildBoards(150, 6)];
  const r = rng(7);
  let compared = 0;
  for (const board of boards) {
    const depth = Math.floor(r() * 4), budget = pick(r, [0, 1, 5, 40, 300, 2000, 4000]);
    same(lookahead(board, depth, budget), lookaheadReference(board, depth, budget)); compared++;
  }
  assert.equal(compared, boards.length);
});
const pick = (r, a) => a[Math.floor(r() * a.length)];

test('generateCandidates matches the reference at every difficulty', () => {
  const plan = {easy: 120, normal: 60, hard: 20, jev: 5};
  let compared = 0;
  for (const [difficulty, count] of Object.entries(plan)) {
    assert.ok(PROFILES[difficulty]);
    for (const board of playedBoards(count, 10 + count)) {
      assert.equal(canonical(generateCandidates(board, difficulty)), canonical(generateCandidatesReference(board, difficulty)));
      same(generateCandidates({cells: board}, difficulty), generateCandidatesReference({cells: board}, difficulty)); compared++;
    }
  }
  assert.equal(compared, 205);
});

test('hex matches the reference encoder', () => {
  const all = Uint8Array.from({length: 256}, (_, i) => i);
  assert.equal(hex(all), hexReference(all)); assert.equal(hex(new Uint8Array(0)), '');
  const r = rng(9);
  for (let i = 0; i < 200; i++) { const bytes = Uint8Array.from({length: Math.floor(r() * 80)}, () => Math.floor(r() * 256)); assert.equal(hex(bytes), hexReference(bytes)); }
});
