import {ACTION_NAMES, tileValue, getLegalActions} from '../public/core/rules.js';
import {sha256} from '../public/core/crypto.js';
import {PROFILES, POLICY_VERSION, generateCandidates, fallbackDecision} from '../public/core/evaluate.js';
export const DEFAULT_MODEL = 'jev-1.13.0';
const RUBRICS = {
  merge: [
    'Important equal tiles are separated by obstructing tiles with no coherent merge sequence.',
    'Useful merges require disrupting the established large-tile arrangement.',
    'A useful merge exists but continuing the sequence is awkward.',
    'Several equal tiles form accessible, orderly merge sequences.',
    'Coherent merge sequences preserve the established large-tile arrangement.'
  ],
  space: [
    'The arrangement has no practical route to restore maneuvering room.',
    'Restoring space requires a narrow sequence with substantial obstruction.',
    'Some routes to restore space exist but are constrained.',
    'Multiple practical merge sequences can reopen empty cells.',
    'The arrangement readily restores maneuvering room through several compatible sequences.'
  ],
  anchor: [
    'The largest tiles are isolated or stranded in conflicting positions.',
    'Preserving the largest tiles requires breaking the main tile ordering.',
    'The largest tiles have a partly stable but vulnerable arrangement.',
    'The largest tiles have a stable anchor with an ordered supporting sequence.',
    'The largest tiles have a durable anchored ordering that remains compatible with useful merges.'
  ]
};
export class JevError extends Error {
  constructor(message, code = 'jev_unavailable') { super(message); this.code = code; }
}
export function buildRequest(board, candidates, difficulty, model, remainingMoves) {
  const questions = {};
  for (const c of candidates) for (const dimension of PROFILES[difficulty].dimensions) {
    questions[`${c.name}_${dimension}`] = {type: 'score', criteria: RUBRICS[dimension],
      instructions: `Evaluate only ${dimension} structure of state.candidates.${c.name}. ` +
        'Use the supplied exact features and afterstate. Do not recalculate arithmetic, invent a spawn, ' +
        'or assume access to future random events. The objective is highest final merge score.'};
  }
  return {model, state: {game: '2048', objective: 'Maximize final merge score.', remainingMoves,
    board: board.cells.map(tileValue),
    candidates: Object.fromEntries(candidates.map(c => [c.name, {
      afterstate: c.afterstate.map(tileValue), mergeGain: c.mergeGain,
      features: c.features, lookahead: c.lookahead}]))}, questions};
}
export function validateResponse(response, request) {
  if (!response || response.model !== request.model || !response.answers || typeof response.answers !== 'object')
    throw new JevError('Response model or answer map does not match the pinned request.', 'jev_invalid');
  if (Object.keys(response.answers).length !== Object.keys(request.questions).length)
    throw new JevError('Response contains missing or unexpected answers.', 'jev_invalid');
  for (const [id, q] of Object.entries(request.questions)) {
    const a = response.answers[id], keys = q.criteria.map((_, i) => String(i));
    if (!a || a.type !== 'score' || !Number.isFinite(a.score) || a.score < 0 || a.score > 4 ||
        !Number.isFinite(a.confidence) || a.confidence < 0 || a.confidence > 1 ||
        !a.probabilities || Object.keys(a.probabilities).length !== 5 ||
        keys.some(k => !Number.isFinite(a.probabilities[k]) || a.probabilities[k] < 0 || a.probabilities[k] > 1) ||
        !a.legend || keys.some(k => typeof a.legend[k] !== 'string')) {
      throw new JevError('Malformed score answer.', 'jev_invalid');
    }
    const total = keys.reduce((s, k) => s + a.probabilities[k], 0);
    const mean = keys.reduce((s, k) => s + Number(k) * a.probabilities[k], 0);
    // The provider rounds score and every probability to two decimals. Each of the
    // five probabilities can therefore be off by .005, so the reconstructed sum can
    // legitimately differ from 1 by up to 5 * .005 = .025, and the reconstructed mean
    // from the reported score by up to (0+1+2+3+4) * .005 + .005 = .055. Tolerances
    // below are those rounding bounds, not sampled values: a tighter bound rejects
    // faithful responses at random and, because one rejection ends the match, made
    // long games impossible.
    if (Math.abs(total - 1) > .03 || Math.abs(mean - a.score) > .06)
      throw new JevError('Inconsistent probability distribution.', 'jev_invalid');
  }
  if (response.usage !== undefined && response.usage !== null &&
      ['input_tokens', 'output_tokens'].some(k => response.usage[k] !== undefined &&
        (!Number.isSafeInteger(response.usage[k]) || response.usage[k] < 0)))
    throw new JevError('Invalid usage record.', 'jev_invalid');
  return response;
}
export function rankCandidates(candidates, response, difficulty) {
  const p = PROFILES[difficulty];
  return candidates.map(c => {
    const dimensions = Object.fromEntries(p.dimensions.map(d => [d, response.answers[`${c.name}_${d}`]]));
    const rubricUtility = p.dimensions.reduce((s, d, i) => s + p.weights[i] * dimensions[d].score / 4, 0);
    return {...c, dimensions, rubricUtility, utility: rubricUtility - 2 * c.features.immediateBlockProbability,
      confidence: p.dimensions.reduce((s, d, i) => s + p.weights[i] * dimensions[d].confidence, 0)};
  }).sort((a, b) => b.utility - a.utility || a.action - b.action);
}
export async function chooseJevAction({board, difficulty = 'normal', model = DEFAULT_MODEL,
  apiKey, mode = 'jev', remainingMoves = 2048, fetcher = fetch, emit = async () => {}, timeoutMs = 10000}) {
  const started = performance.now(), featureStart = performance.now();
  const candidates = generateCandidates(board, difficulty), featureMs = performance.now() - featureStart;
  await emit('candidates_generated', {stateHash: await sha256(board), difficulty, featureMs, candidates});
  if (!candidates.length) return {action: null, source: 'finished', candidates, latencyMs: performance.now() - started};
  if (candidates.length === 1 || mode === 'local') {
    const action = candidates.length === 1 ? candidates[0].action : fallbackDecision(candidates);
    return {action, source: candidates.length === 1 ? 'forced' : 'heuristic',
      candidates, featureMs, latencyMs: performance.now() - started, model: null, policyVersion: POLICY_VERSION,
      confidence: null, usage: null, requestCount: 0, retryCount: 0};
  }
  if (!apiKey) throw new JevError('JEV is not configured. Choose local practice or configure the server key.', 'jev_not_configured');
  const request = buildRequest(board, candidates, difficulty, model, remainingMoves), requestHash = await sha256(request);
  let response, successfulLatency = null;
  const attempts = [];
  for (let attempt = 1; attempt <= 2; attempt++) {
    await emit('jev_requested', {attempt, requestHash, request});
    const callStart = performance.now();
    try {
      const res = await fetcher('https://api.typesafe.ai/v1/systemone', {
        method: 'POST', headers: {'Authorization': `Bearer ${apiKey}`, 'Content-Type': 'application/json'},
        body: JSON.stringify(request), signal: AbortSignal.timeout(timeoutMs)
      });
      // Bound response size before parsing or journaling untrusted provider output.
      const reader = res.body?.getReader(); let text = '', bytes = 0;
      if (reader) {
        const decoder = new TextDecoder();
        while (true) {
          const chunk = await reader.read(); if (chunk.done) break;
          bytes += chunk.value.length;
          if (bytes > 512000) { await reader.cancel(); throw new JevError('Provider response exceeds limit.', 'jev_invalid'); }
          text += decoder.decode(chunk.value, {stream: true});
        }
        text += decoder.decode();
      }
      const latencyMs = performance.now() - callStart;
      let parsed; try { parsed = JSON.parse(text); } catch { parsed = null; }
      // Request state has no credentials. Only documented response fields are retained.
      const safeResponse = parsed && {model: parsed.model ?? null, answers: parsed.answers ?? null, usage: parsed.usage ?? null};
      await emit('jev_response', {attempt, requestHash, httpStatus: res.status, latencyMs,
        response: safeResponse, responseBytes: bytes});
      attempts.push({attempt, status: res.status, latencyMs, usage: safeResponse?.usage ?? null});
      if (!res.ok) {
        const transient = [429, 500, 502, 503, 504, 529].includes(res.status);
        if (transient && attempt === 1) {
          const retryAfter = Number(res.headers.get('retry-after'));
          if (Number.isFinite(retryAfter) && retryAfter > 2) throw new JevError('Provider requests a longer backoff; retry later.');
          await new Promise(r => setTimeout(r, Math.max(300, (retryAfter || .6) * 1000)));
          continue;
        }
        throw new JevError(`JEV HTTP ${res.status}; no substitute move was applied.`);
      }
      response = validateResponse(parsed, request); successfulLatency = latencyMs; break;
    } catch (error) {
      await emit('jev_failed', {attempt, requestHash, code: error.code || 'jev_network',
        latencyMs: performance.now() - callStart});
      // A response that fails validation is a bad sample, not a settled verdict: the
      // provider is nondeterministic, so one retry usually returns a well-formed one.
      // Everything else keeps the original semantics and is never retried here.
      const resample = error instanceof JevError && error.code === 'jev_invalid' && attempt === 1;
      if (!resample && (error instanceof JevError || attempt === 2)) throw error instanceof JevError ? error : new JevError('JEV timed out or the network failed.');
      await new Promise(r => setTimeout(r, 500));
    }
  }
  const ranked = rankCandidates(candidates, response, difficulty), selected = ranked[0];
  if (!getLegalActions(board).includes(selected.action)) throw new JevError('Selected action is stale.', 'jev_invalid');
  return {action: selected.action, source: 'jev', model: response.model, policyVersion: POLICY_VERSION,
    requestHash, responseHash: await sha256({model: response.model, answers: response.answers, usage: response.usage ?? null}), candidates: ranked, confidence: selected.confidence,
    utilityMargin: ranked.length > 1 ? selected.utility - ranked[1].utility : null,
    featureMs, providerMs: successfulLatency, latencyMs: performance.now() - started,
    usage: response.usage ?? null, requestCount: attempts.length, retryCount: Math.max(0, attempts.length - 1), attempts};
}
