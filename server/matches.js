import {RULES_VERSION, MOVE_LIMIT, canonical, createDuel, getLegalActions, advanceRound} from '../public/core/rules.js';
import {RNG_VERSION, randomHex, initialCells, seedCommitment, encrypt, decrypt, deriveSpawn, sha256} from '../public/core/crypto.js';
import {POLICY_VERSION, PROFILES, generateCandidates} from '../public/core/evaluate.js';
import {createEvents, verifyBundle, ZERO_HASH} from '../public/core/audit.js';
import {chooseJevAction, DEFAULT_MODEL} from './jev.js';
import {HttpError} from './db.js';
import {sessionContext} from './auth.js';
import {BUILD_INFO} from './build-info.js';
const LEASE_MS = 45000;
export function partition(manifest) {
  return [manifest.rulesVersion, manifest.difficulty, manifest.policyVersion, manifest.model, manifest.moveLimit].join('|');
}
export async function ownedMatch(id, session, store) {
  const m = await store.get('SELECT * FROM matches WHERE id=?', [id]);
  if (!m || (m.user_id ? m.user_id !== session.user_id : m.session_id !== session.id))
    throw new HttpError(404, 'Match not found.');
  return m;
}
export function publicMatch(m) {
  return {id: m.id, manifest: JSON.parse(m.manifest_json), state: JSON.parse(m.state_json), mode: m.mode,
    ranked: Boolean(m.ranked), commitment: m.commitment, status: m.status, verified: Boolean(m.verified),
    eventCount: m.event_seq, eventHead: m.event_head, expiresAt: m.expires_at,
    pending: m.pending_json ? JSON.parse(m.pending_json) : null,
    context: m.guild_id ? {guildId: m.guild_id, channelId: m.channel_id} : null};
}
export async function createMatch(body, session, store, env) {
  const difficulty = body.difficulty ?? 'normal', mode = body.mode ?? (env.TYPESAFE_API_KEY ? 'jev' : 'local');
  if (!Object.hasOwn(PROFILES, difficulty) || !['jev', 'local'].includes(mode) || typeof body.ranked !== 'boolean')
    throw new HttpError(400, 'Invalid difficulty, opponent mode, or ranked flag.');
  if (body.ranked && (!session.user_id || mode !== 'jev')) throw new HttpError(403, 'Ranked play requires Discord and JEV.');
  if (mode === 'jev' && !env.TYPESAFE_API_KEY) throw new HttpError(503, 'JEV is not configured. Local practice remains available.', 'jev_not_configured');
  const owner = session.user_id || session.id;
  await store.limit('starts:' + owner, 20, 3600);
  await store.run(`UPDATE matches SET status='expired',ranked=0,lease_token=NULL,lease_expires=NULL WHERE expires_at<? AND status='active'`, [Date.now()]);
  const exists = await store.get(`SELECT id FROM matches WHERE status='active' AND (session_id=? OR (user_id IS NOT NULL AND user_id=?))`,
    [session.id, session.user_id]);
  if (exists) throw new HttpError(409, 'Resume or resign your existing match before starting another.', 'active_match', {matchId: exists.id});
  const id = randomHex(16), seed = randomHex(), now = Date.now(), context = body.ranked ? sessionContext(session) : null;
  const moveLimit = env.TEST_MOVE_LIMIT ? Number(env.TEST_MOVE_LIMIT) : MOVE_LIMIT;
  const model = mode === 'jev' ? env.JEV_MODEL || DEFAULT_MODEL : null;
  if (model && /latest/i.test(model)) throw new HttpError(503, 'Pin a versioned model before enabling matches.');
  const manifest = {schemaVersion: 1, matchId: id, game: '2048', rulesVersion: RULES_VERSION, rngVersion: RNG_VERSION,
    policyVersion: POLICY_VERSION, difficulty, model, profile: PROFILES[difficulty], moveLimit,
    mode, ranked: body.ranked, createdAt: new Date(now).toISOString(), evidenceClass: 'server-recorded',
    build: BUILD_INFO, humanComparisonPolicy: 'easy-search-proxy-v1'};
  const cells = await initialCells(seed), state = createDuel(cells, {matchId: id, moveLimit});
  const commitment = await seedCommitment(manifest, seed), seedCipher = await encrypt(env.SEED_ENCRYPTION_KEY, seed);
  const events = await createEvents(null, [{type: 'match_started', data: {manifest, initialCells: cells, commitment}}], {matchId: id, clockId: id});
  const e = events[0];
  try {
    await store.batch([
      [`INSERT INTO matches(id,session_id,user_id,manifest_json,commitment,seed_cipher,state_json,revision,ranked,mode,
        guild_id,channel_id,status,created_at,expires_at,event_seq,event_head) VALUES(?,?,?,?,?,?,?,0,?,?,?,?,?,?,?,1,?)`,
        [id, session.id, session.user_id, canonical(manifest), commitment, seedCipher, canonical(state), Number(body.ranked), mode,
          context?.guildId ?? null, context?.channelId ?? null, 'active', now, now + 86400000, e.hash]],
      ['INSERT INTO events(match_id,seq,type,event_json,prev_hash,hash) VALUES(?,?,?,?,?,?)', [id, 1, e.type, canonical(e), ZERO_HASH, e.hash]]
    ]);
  } catch { throw new HttpError(409, 'Another match was started concurrently.', 'active_match'); }
  return {match: publicMatch(await store.get('SELECT * FROM matches WHERE id=?', [id])), events};
}
export async function bundleMetadata(m, env, internal = false) {
  return {formatVersion: 1, manifest: JSON.parse(m.manifest_json), commitment: m.commitment,
    seed: internal || m.status !== 'active' ? await decrypt(env.SEED_ENCRYPTION_KEY, m.seed_cipher) : null,
    finalState: JSON.parse(m.state_json), status: m.status, ranked: Boolean(m.ranked), verified: Boolean(m.verified), head: m.event_head};
}
export async function matchBundle(m, store, env, internal = false) {
  const events = []; for await (const event of store.streamEvents(m.id, m.event_seq)) events.push(event);
  return {...await bundleMetadata(m, env, internal), events,
    telemetry: (await store.all('SELECT * FROM telemetry WHERE match_id=? ORDER BY received_at,id', [m.id]))
      .map(t => ({id: t.id, receivedAt: t.received_at, type: t.type, data: JSON.parse(t.data_json)}))};
}
async function acquire(m, pending, store) {
  const token = randomHex(16), now = Date.now();
  const response = await store.run(`UPDATE matches SET lease_token=?,lease_expires=?,pending_json=?
    WHERE id=? AND revision=? AND status='active' AND (lease_token IS NULL OR lease_expires<?)
    AND (pending_json IS NULL OR pending_json=?)`,
    [token, now + LEASE_MS, canonical(pending), m.id, m.revision, now, m.pending_json]);
  if (!response.meta.changes) throw new HttpError(409, 'A round is in progress. Resume it instead of submitting a second move.', 'round_pending');
  return token;
}
async function finalize(m, session, store, env) {
  if (m.verified) return m;
  const token = randomHex(16), now = Date.now();
  const locked = await store.run(`UPDATE matches SET lease_token=?,lease_expires=? WHERE id=? AND verified=0
    AND status='complete' AND (lease_token IS NULL OR lease_expires<?)`, [token, now + LEASE_MS, m.id, now]);
  if (!locked.meta.changes) return m;
  try {
    const bundle = {...await bundleMetadata(m, env, true), events: store.streamEvents(m.id, m.event_seq)}, report = await verifyBundle(bundle, {requireComplete: true, expectedHead: m.event_head});
    // Verification may take longer on large traces; renew only while still owning this lease.
    await store.run('UPDATE matches SET lease_expires=? WHERE id=? AND lease_token=?', [Date.now() + LEASE_MS, m.id, token]);
    const statements = [];
    const state = report.state, manifest = bundle.manifest;
    const eligible = Boolean(m.ranked && m.user_id && report.rankedEligible);
    const records = [{type: 'match_verified', data: {rounds: report.rounds, seedVerified: true,
      verifiedHead: report.head, rankedEligible: eligible, nativeDecisions: report.nativeDecisions}}];
    if (eligible) {
      statements.push([`INSERT OR IGNORE INTO results(match_id,user_id,partition_key,guild_id,channel_id,human_score,
        jev_score,max_tile,moves,outcome,replay_hash,finished_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)`,
        [m.id, m.user_id, partition(manifest), m.guild_id, m.channel_id, state.human.score, state.jev.score,
          2 ** Math.max(...state.human.cells), state.human.moves,
          state.winner === 'human' ? 'WIN' : state.winner === 'jev' ? 'LOSS' : 'DRAW', report.head, Date.now()]]);
      records.push({type: 'result_published', data: {partition: partition(manifest), score: state.human.score,
        outcome: state.winner, scopes: m.guild_id ? ['world', 'server', 'channel'] : ['world']}});
    }
    statements.push(['UPDATE matches SET verified=1,lease_token=NULL,lease_expires=NULL WHERE id=? AND lease_token=?', [m.id, token]]);
    await store.append(m.id, token, records, 'verification:' + token, statements);
  } catch (error) {
    // Do not publish a result after an audit failure. Leave a durable failure record when possible.
    try { await store.append(m.id, token, [{type: 'verification_failed', data: {code: 'replay_mismatch'}}], token); } catch { /* lease may have expired */ }
    await store.run('UPDATE matches SET lease_token=NULL,lease_expires=NULL WHERE id=? AND lease_token=?', [m.id, token]);
    throw error;
  }
  return store.get('SELECT * FROM matches WHERE id=?', [m.id]);
}
export async function getMatch(id, session, store, env) {
  let m = await ownedMatch(id, session, store);
  if (m.status === 'active' && m.expires_at <= Date.now()) {
    await store.run(`UPDATE matches SET status='expired',ranked=0,lease_token=NULL,lease_expires=NULL WHERE id=? AND expires_at<=?`, [id, Date.now()]);
    m = await ownedMatch(id, session, store);
  }
  if (m.status === 'complete' && !m.verified) m = await finalize(m, session, store, env);
  return publicMatch(m);
}
export async function stepMatch(id, body, session, store, env) {
  if (typeof body.requestId !== 'string' || !/^[a-zA-Z0-9-]{12,80}$/.test(body.requestId) ||
      !Number.isSafeInteger(body.expectedRevision) ||
      !(body.humanAction === null || [0, 1, 2, 3].includes(body.humanAction))) throw new HttpError(400, 'Invalid step request.');
  let m = await ownedMatch(id, session, store);
  const previous = await store.get('SELECT * FROM round_requests WHERE match_id=? AND request_id=?', [id, body.requestId]);
  if (previous) {
    if (previous.action !== body.humanAction || previous.revision !== body.expectedRevision) throw new HttpError(409, 'Request ID reused with different input.');
    return {match: await getMatch(id, session, store, env), duplicate: true};
  }
  if (m.status !== 'active' || m.expires_at <= Date.now()) throw new HttpError(409, 'Match is complete or expired.');
  if (m.revision !== body.expectedRevision) throw new HttpError(409, 'Stale board revision. Reload the match.', 'stale_revision');
  const state = JSON.parse(m.state_json), manifest = JSON.parse(m.manifest_json);
  if (state.human.status === 'playing' ? !getLegalActions(state.human).includes(body.humanAction) : body.humanAction !== null)
    throw new HttpError(422, 'That direction does not change your board.', 'illegal_action');
  let pending = {requestId: body.requestId, humanAction: body.humanAction, expectedRevision: body.expectedRevision};
  if (m.pending_json) {
    pending = JSON.parse(m.pending_json);
    if (pending.requestId !== body.requestId || pending.humanAction !== body.humanAction)
      throw new HttpError(409, 'Retry the already reserved direction; it cannot be changed.', 'pending_locked', pending);
  }
  await store.limit('steps:' + (session.user_id || session.id), 180, 60);
  const token = await acquire(m, pending, store), clockId = 'round:' + token, start = performance.now();
  try {
    const reserved = await store.append(id, token, [{type: m.pending_json ? 'round_resumed' : 'round_reserved',
      data: pending}], clockId);
    const parentSeq = reserved[0].seq;
    const emit = async (type, data) => {
      if (type === 'jev_requested') {
        await store.limit('provider:global', Number(env.JEV_REQUESTS_PER_DAY || 10000), 86400);
        await store.limit('provider:' + (session.user_id || session.id), session.user_id ? 6000 : 600, 86400);
      }
      await store.append(id, token, [{type, data, parentSeq}], clockId);
    };
    let decision;
    if (state.jev.status !== 'playing') decision = {action: null, source: 'finished', candidates: [], latencyMs: 0};
    else decision = await chooseJevAction({board: state.jev, difficulty: manifest.difficulty,
      model: manifest.model || DEFAULT_MODEL, apiKey: env.TYPESAFE_API_KEY, mode: m.mode,
      remainingMoves: state.moveLimit - state.jev.moves, emit, fetcher: env.FETCH || fetch,
      timeoutMs: Number(env.JEV_TIMEOUT_MS || 10000)});
    await emit('decision_selected', {action: decision.action, source: decision.source,
      stateHash: await sha256(state.jev), requestHash: decision.requestHash ?? null, confidence: decision.confidence ?? null});
    // Actions are locked before any future spawn is materialized or returned.
    const seed = await decrypt(env.SEED_ENCRYPTION_KEY, m.seed_cipher), spawnEvent = await deriveSpawn(seed, state.round);
    const applied = advanceRound(state, {humanAction: body.humanAction, jevAction: decision.action, spawnEvent});
    const analyticsStart = performance.now();
    const humanCandidates = state.human.status === 'playing' ? generateCandidates(state.human, 'easy') : [];
    const data = {actions: {human: body.humanAction, jev: decision.action}, state: applied.state,
      spawnEvent, details: applied.details, decision, humanCandidates,
      preStateHash: await sha256(state), postStateHash: await sha256(applied.state),
      timings: {analyticsMs: performance.now() - analyticsStart, roundServerMs: performance.now() - start}};
    await store.append(id, token, [{type: 'round_committed', data, parentSeq}], clockId, [
      ['INSERT INTO round_requests(match_id,request_id,revision,action,response_json) VALUES(?,?,?,?,?)',
        [id, body.requestId, body.expectedRevision, body.humanAction, canonical({postStateHash: data.postStateHash})]],
      [`UPDATE matches SET state_json=?,revision=?,status=?,pending_json=NULL,lease_token=NULL,lease_expires=NULL
        WHERE id=? AND lease_token=?`, [canonical(applied.state), applied.state.revision,
        applied.state.status === 'complete' ? 'complete' : 'active', id, token]]
    ]);
    m = await ownedMatch(id, session, store);
    if (m.status === 'complete') m = await finalize(m, session, store, env);
    return {match: publicMatch(m), decision};
  } catch (error) {
    try { await store.append(id, token, [{type: 'round_paused', data: {code: error.code || 'round_error'}}], clockId); } catch { /* committed or lost lease */ }
    await store.run('UPDATE matches SET lease_token=NULL,lease_expires=NULL WHERE id=? AND lease_token=?', [id, token]);
    if (error instanceof HttpError) throw error;
    if (error.code?.startsWith('jev')) throw new HttpError(503, error.message, error.code);
    throw new HttpError(500, 'The round could not be completed. Retry the reserved move.', 'round_error');
  }
}
export async function controlMatch(id, action, session, store) {
  const m = await ownedMatch(id, session, store);
  if (m.status !== 'active') throw new HttpError(409, 'Match is no longer active.');
  if (!['resign', 'continue_practice'].includes(action)) throw new HttpError(400, 'Unknown match control.');
  const token = randomHex(16);
  const locked = await store.run(`UPDATE matches SET lease_token=?,lease_expires=? WHERE id=? AND status='active'
    AND (lease_token IS NULL OR lease_expires<?)`, [token, Date.now() + LEASE_MS, id, Date.now()]);
  if (!locked.meta.changes) throw new HttpError(409, 'Wait for the in-flight round before changing the match.');
  await store.append(id, token, [{type: action === 'resign' ? 'match_resigned' : 'practice_enabled',
    data: {revision: m.revision, previousMode: m.mode, previousRanked: Boolean(m.ranked)}}], token, [
    [`UPDATE matches SET ranked=0,mode=?,status=?,pending_json=?,lease_token=NULL,lease_expires=NULL WHERE id=? AND lease_token=?`,
      [action === 'continue_practice' ? 'local' : m.mode, action === 'resign' ? 'resigned' : 'active',
        action === 'resign' ? null : m.pending_json, id, token]]
  ]);
  return publicMatch(await ownedMatch(id, session, store));
}
