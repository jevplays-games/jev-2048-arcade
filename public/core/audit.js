import {RULES_VERSION, canonical, createDuel, advanceRound, simulateMove, getLegalActions, tileValue} from './rules.js';
import {sha256, initialCells, deriveSpawn, seedCommitment, RNG_VERSION} from './crypto.js';
import {PROFILES} from './evaluate.js';
export const ZERO_HASH = '0'.repeat(64);
export async function createEvents(previous, records, context = {}) {
  let seq = previous?.seq || 0, prevHash = previous?.hash || ZERO_HASH;
  const events = [];
  for (const record of records) {
    const envelope = {schemaVersion: 1, matchId: context.matchId, seq: ++seq,
      type: record.type, occurredAt: new Date().toISOString(), clockId: context.clockId || 'unspecified',
      monotonicMs: performance.now(), parentSeq: record.parentSeq ?? null,
      data: record.data, prevHash};
    const event = {...envelope, hash: await sha256(envelope)};
    prevHash = event.hash; events.push(event);
  }
  return events;
}
export async function verifyChain(events, expectedHead = null) {
  let previous = ZERO_HASH, seq = 0, matchId = null;
  for (const event of events) {
    const {hash, ...envelope} = event;
    if (event.schemaVersion !== 1 || event.seq !== ++seq || event.prevHash !== previous)
      throw new Error(`Broken event sequence at ${event.seq}.`);
    matchId ??= event.matchId;
    if (event.matchId !== matchId || await sha256(envelope) !== hash)
      throw new Error(`Event hash mismatch at ${event.seq}.`);
    if (event.parentSeq !== null && (!Number.isInteger(event.parentSeq) || event.parentSeq < 1 || event.parentSeq >= event.seq))
      throw new Error(`Invalid causal reference at ${event.seq}.`);
    previous = hash;
  }
  if (expectedHead && previous !== expectedHead) throw new Error('Trusted event head mismatch.');
  return {events: seq, head: previous};
}
export async function verifyBundle(bundle, {requireComplete = false, expectedHead = null} = {}) {
  const manifest = bundle.manifest;
  let chainHead = ZERO_HASH, chainCount = 0, state = null;
  if (!manifest || manifest.rulesVersion !== RULES_VERSION || manifest.rngVersion !== RNG_VERSION)
    throw new Error('Unsupported replay version.');
  let rounds = 0, nativeDecisions = 0, practice = manifest.mode === 'local';
  const requests = new Map(), responses = new Map();
  let reserved = null;
  for await (const e of bundle.events) {
    const {hash, ...envelope} = e;
    if (e.schemaVersion !== 1 || e.seq !== ++chainCount || e.prevHash !== chainHead || e.matchId !== manifest.matchId ||
        await sha256(envelope) !== hash) throw new Error(`Event hash or sequence mismatch at ${e.seq}.`);
    if (e.parentSeq !== null && (!Number.isInteger(e.parentSeq) || e.parentSeq < 1 || e.parentSeq >= e.seq))
      throw new Error('Invalid causal reference.');
    chainHead = hash;
    if (chainCount === 1) {
      if (e.type !== 'match_started' || canonical(e.data.manifest) !== canonical(manifest))
        throw new Error('Manifest is not bound to the initial event.');
      if (bundle.commitment !== e.data.commitment) throw new Error('Initial commitment mismatch.');
      if (bundle.seed) {
        if (await seedCommitment(manifest, bundle.seed) !== bundle.commitment) throw new Error('Seed commitment mismatch.');
        if (canonical(await initialCells(bundle.seed)) !== canonical(e.data.initialCells)) throw new Error('Initial board mismatch.');
      }
      state = createDuel(e.data.initialCells, {matchId: manifest.matchId, moveLimit: manifest.moveLimit});
    }
    if (e.type === 'practice_enabled') practice = true;
    if (['round_reserved', 'round_resumed'].includes(e.type)) reserved = e.data;
    if (e.type === 'jev_requested') {
      if (await sha256(e.data.request) !== e.data.requestHash) throw new Error('JEV request hash mismatch.');
      requests.set(e.data.requestHash, e.data.request);
    }
    if (e.type === 'jev_response' && e.data.httpStatus === 200 && e.data.response) {
      responses.set(await sha256(e.data.response), e.data.response);
    }
    if (e.type !== 'round_committed') continue;
    const d = e.data;
    if (!reserved || reserved.expectedRevision !== state.revision || reserved.humanAction !== d.actions.human)
      throw new Error('Missing or inconsistent reserved action.');
    if (!['jev', 'forced', 'heuristic', 'finished', 'scripted'].includes(d.decision.source)) throw new Error('Unknown decision source.');
    const legal = state.jev.status === 'playing' ? getLegalActions(state.jev) : [];
    if (d.decision.source === 'forced' && (legal.length !== 1 || legal[0] !== d.actions.jev)) throw new Error('Invalid forced move.');
    if (d.decision.source === 'finished' && (legal.length || d.actions.jev !== null)) throw new Error('Invalid finished-board decision.');
    for (const candidate of d.decision.candidates || []) {
      if (!legal.includes(candidate.action) || canonical(simulateMove(state.jev, candidate.action).cells) !== canonical(candidate.afterstate))
        throw new Error('Candidate afterstate mismatch.');
    }
    if (d.state.round !== rounds + 1 || await sha256(state) !== d.preStateHash) throw new Error('Pre-state mismatch.');
    if (bundle.seed && canonical(await deriveSpawn(bundle.seed, rounds, 'move')) !== canonical(d.spawnEvent))
      throw new Error('Spawn stream mismatch.');
    if (d.decision.action !== d.actions.jev) throw new Error('Decision/action mismatch.');
    if (d.decision.source === 'jev') {
      nativeDecisions++;
      const request = requests.get(d.decision.requestHash), response = responses.get(d.decision.responseHash);
      if (!request || !response || request.model !== manifest.model || response.model !== manifest.model)
        throw new Error('Missing or mismatched provider evidence.');
      if (canonical(request.state.board) !== canonical(state.jev.cells.map(tileValue))) throw new Error('Provider request used a different board.');
      const profile = PROFILES[manifest.difficulty];
      if (!profile || canonical(profile) !== canonical(manifest.profile)) throw new Error('Unsupported policy profile.');
      const candidates = d.decision.candidates;
      if (new Set(candidates.map(c => c.action)).size !== legal.length || candidates.length !== legal.length)
        throw new Error('Incomplete candidate set.');
      const scores = candidates.map(c => {
        let utility = -2 * c.features.immediateBlockProbability;
        for (let i = 0; i < profile.dimensions.length; i++) {
          const dimension = profile.dimensions[i], answer = response.answers[c.name + '_' + dimension];
          if (!answer || answer.type !== 'score' || !Number.isFinite(answer.score) || answer.score < 0 || answer.score > 4 ||
              canonical(answer) !== canonical(c.dimensions?.[dimension] ?? null)) throw new Error('Candidate model evidence mismatch.');
          const probabilities = answer.probabilities;
          if (!probabilities || Object.keys(probabilities).length !== 5 || [0,1,2,3,4].some(j =>
            !Number.isFinite(probabilities[j]) || probabilities[j] < 0 || probabilities[j] > 1)) throw new Error('Invalid recorded probabilities.');
          const total = Object.values(probabilities).reduce((sum, p) => sum + p, 0);
          const mean = Object.entries(probabilities).reduce((sum, [level, p]) => sum + Number(level) * p, 0);
          if (Math.abs(total - 1) > .002 || Math.abs(mean - answer.score) > .025) throw new Error('Inconsistent recorded probabilities.');
          utility += profile.weights[i] * answer.score / 4;
        }
        if (!Number.isFinite(c.utility) || Math.abs(c.utility - utility) > 1e-10) throw new Error('Policy utility mismatch.');
        return {action: c.action, utility};
      }).sort((a, b) => b.utility - a.utility || a.action - b.action);
      if (scores[0]?.action !== d.actions.jev) throw new Error('Selected action does not follow the recorded policy.');
    }
    if (manifest.ranked && !practice && !['jev', 'forced', 'finished'].includes(d.decision.source)) throw new Error('Undeclared ranked substitution.');
    if (d.decision.source === 'scripted' && manifest.evidenceClass !== 'scripted-baseline-benchmark') throw new Error('Scripted decision outside an explicit benchmark.');
    const applied = advanceRound(state, {humanAction: d.actions.human, jevAction: d.actions.jev, spawnEvent: d.spawnEvent});
    if (canonical(applied.details) !== canonical(d.details) || canonical(applied.state) !== canonical(d.state) ||
        await sha256(applied.state) !== d.postStateHash) throw new Error('Transition or score mismatch.');
    state = applied.state; rounds++; reserved = null;
    requests.clear(); responses.clear(); // Retain only evidence for the pending round, not the entire match.
  }
  if (!state) throw new Error('Empty replay.');
  const requiredHead = expectedHead || bundle.head;
  if (requiredHead && chainHead !== requiredHead) throw new Error('Trusted event head mismatch.');
  if (requireComplete && (state.status !== 'complete' || !bundle.seed)) throw new Error('Complete seeded replay required.');
  if (bundle.finalState && canonical(bundle.finalState) !== canonical(state)) throw new Error('Final state mismatch.');
  return {ok: true, events: chainCount, head: chainHead, rounds, state, nativeDecisions, seedVerified: Boolean(bundle.seed),
    complete: state.status === 'complete', rankedEligible: Boolean(manifest.ranked && !practice && state.status === 'complete'),
    replayMethod: 'recorded-actions; no provider calls'};
}
