import {Store, HttpError} from './db.js';
import {getSession, requireWrite, discordConfigured, beginOAuth, finishOAuth,
  handleInteraction, consumeContext, sessionContext, sessionCookie} from './auth.js';
import {activityConfig, createActivitySession} from './activity.js';
import {createMatch, getMatch, ownedMatch, stepMatch, controlMatch, matchBundle, bundleMetadata, partition} from './matches.js';
import {analyze, csv} from '../public/core/analytics.js';
import {verifyBundle} from '../public/core/audit.js';
import {RULES_VERSION} from '../public/core/rules.js';
import {POLICY_VERSION, PROFILES} from '../public/core/evaluate.js';
import {DEFAULT_MODEL} from './jev.js';
import {sha256, randomHex} from '../public/core/crypto.js';
const HEADERS = {
  'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer',
  'Content-Security-Policy': "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; worker-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'self' https://discord.com",
  'Permissions-Policy': 'camera=(), microphone=(), geolocation=()'
};
export const json = (data, status = 200) => Response.json(data, {status});
async function readBody(request, max = 16384) {
  if (!(request.headers.get('content-type') || '').toLowerCase().startsWith('application/json'))
    throw new HttpError(415, 'Use application/json.');
  const reader = request.body?.getReader(); let length = 0, data = '';
  if (reader) {
    const decoder = new TextDecoder();
    while (true) {
      const {done, value} = await reader.read(); if (done) break;
      length += value.length; if (length > max) { await reader.cancel(); throw new HttpError(413, 'Request is too large.'); }
      data += decoder.decode(value, {stream: true});
    }
    data += decoder.decode();
  }
  try {
    const body = JSON.parse(data);
    if (!body || typeof body !== 'object' || Array.isArray(body)) throw new Error();
    return body;
  } catch { throw new HttpError(400, 'Invalid JSON object.'); }
}
function fields(body, allowed) {
  if (Object.keys(body).some(key => !allowed.includes(key))) throw new HttpError(400, 'Unknown request field.');
  return body;
}
function numberParam(params, key, fallback, min, max) {
  const n = params.has(key) ? Number(params.get(key)) : fallback;
  if (!Number.isInteger(n) || n < min || n > max) throw new HttpError(400, `Invalid ${key}.`);
  return n;
}
async function leaderboard(url, session, store, env) {
  const scope = url.searchParams.get('scope') || 'world', difficulty = url.searchParams.get('difficulty') || 'normal';
  const period = url.searchParams.get('period') || 'all';
  if (!['world', 'server', 'channel'].includes(scope) || !Object.hasOwn(PROFILES, difficulty) || !['all', 'week'].includes(period))
    throw new HttpError(400, 'Invalid leaderboard filter.');
  const context = sessionContext(session);
  if (scope !== 'world' && !context) throw new HttpError(403, 'Launch /2048 in a participating Discord channel to view this scope.', 'context_required');
  const limit = numberParam(url.searchParams, 'limit', 25, 1, 100), offset = numberParam(url.searchParams, 'offset', 0, 0, 100000);
  const requestedModel = url.searchParams.get('model') || env.JEV_MODEL || DEFAULT_MODEL;
  if (!/^[a-zA-Z0-9.-]{1,80}$/.test(requestedModel)) throw new HttpError(400, 'Invalid model cohort.');
  const key = partition({rulesVersion: RULES_VERSION, difficulty, policyVersion: POLICY_VERSION, model: requestedModel, moveLimit: 2048});
  const args = [key]; let condition = 'r.partition_key=?';
  if (scope !== 'world') { condition += ' AND r.guild_id=?'; args.push(context.guildId); }
  if (scope === 'channel') { condition += ' AND r.channel_id=?'; args.push(context.channelId); }
  if (period === 'week') {
    const now = new Date(), day = (now.getUTCDay() + 6) % 7;
    const start = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() - day);
    condition += ' AND r.finished_at>=?'; args.push(start);
  }
  const entries = await store.all(`WITH chosen AS (
    SELECT r.*,u.display_name,ROW_NUMBER() OVER(PARTITION BY r.user_id ORDER BY r.human_score DESC,r.finished_at,r.match_id) AS pick
    FROM results r JOIN users u ON u.id=r.user_id WHERE ${condition}
  ), ranked AS (
    SELECT *,RANK() OVER(ORDER BY human_score DESC) AS rank FROM chosen WHERE pick=1
  ) SELECT rank,display_name,human_score,jev_score,max_tile,moves,outcome,finished_at
    FROM ranked ORDER BY human_score DESC,finished_at,match_id LIMIT ? OFFSET ?`, [...args, limit + 1, offset]);
  return {scope, period, partition: key, entries: entries.slice(0, limit), nextOffset: entries.length > limit ? offset + limit : null};
}
async function telemetry(id, body, session, store) {
  await ownedMatch(id, session, store);
  if (!Array.isArray(body.events) || body.events.length > 20) throw new HttpError(400, 'Telemetry batches contain at most 20 events.');
  await store.limit('telemetry:' + session.id, 30, 60);
  const allowed = ['input_attempt', 'round_network', 'page_visibility', 'frame_gap', 'ui_error', 'analysis_opened', 'export_requested'];
  const statements = [];
  for (const event of body.events) {
    if (!allowed.includes(event.type) || typeof event.id !== 'string' || !/^[a-zA-Z0-9-]{12,80}$/.test(event.id)) continue;
    const data = {trust: 'client-reported'};
    for (const key of ['thinkMs', 'rttMs', 'frameGapMs', 'revision', 'action']) {
      const v = event.data?.[key]; if (Number.isFinite(v) && v >= 0 && v <= 86400000) data[key] = v;
    }
    for (const key of ['legal', 'visible', 'success']) if (typeof event.data?.[key] === 'boolean') data[key] = event.data[key];
    statements.push(['INSERT OR IGNORE INTO telemetry(id,match_id,received_at,type,data_json) VALUES(?,?,?,?,?)',
      [event.id, id, Date.now(), event.type, JSON.stringify(data)]]);
  }
  if (statements.length) await store.batch(statements);
  return {accepted: statements.length, trust: 'untrusted'};
}
async function adminAnalytics(request, url, store, env) {
  const bearer = request.headers.get('authorization') || '';
  if (!env.ADMIN_API_KEY || await sha256(bearer) !== await sha256('Bearer ' + env.ADMIN_API_KEY))
    throw new HttpError(403, 'Administrator access required.');
  const days = numberParam(url.searchParams, 'days', 7, 1, 365), since = Date.now() - days * 86400000;
  const cohorts = await store.all(`SELECT json_extract(manifest_json,'$.difficulty') AS difficulty,
    json_extract(manifest_json,'$.model') AS model, json_extract(manifest_json,'$.policyVersion') AS policy,
    mode,ranked,status,COUNT(*) AS matches,SUM(revision) AS committed_rounds,AVG(revision) AS mean_rounds,
    SUM(verified) AS verified_matches FROM matches WHERE created_at>=?
    GROUP BY difficulty,model,policy,mode,ranked,status`, [since]);
  const events = await store.all(`SELECT e.type,COUNT(*) AS count FROM events e JOIN matches m ON m.id=e.match_id
    WHERE m.created_at>=? GROUP BY e.type`, [since]);
  const usage = await store.get(`SELECT COUNT(*) AS responses,
    SUM(json_extract(e.event_json,'$.data.response.usage.input_tokens')) AS known_input_tokens,
    SUM(json_extract(e.event_json,'$.data.response.usage.output_tokens')) AS known_output_tokens,
    SUM(CASE WHEN json_extract(e.event_json,'$.data.response.usage.input_tokens') IS NULL THEN 1 ELSE 0 END) AS missing_input_usage
    FROM events e JOIN matches m ON m.id=e.match_id WHERE e.type='jev_response' AND m.created_at>=?`, [since]);
  return {since: new Date(since).toISOString(), cohorts, eventCounts: events, usage,
    caveat: 'Aggregate operational analytics; no player names, tokens, or private channel identifiers are included.'};
}
async function route(request, env) {
  const url = new URL(request.url), path = url.pathname, method = request.method, store = new Store(env.DB);
  if (!env.PUBLIC_ORIGIN || url.origin !== env.PUBLIC_ORIGIN) throw new HttpError(421, 'Unexpected application origin.');
  if (!env.APP_SIGNING_KEY || !env.SEED_ENCRYPTION_KEY) throw new HttpError(503, 'Server secrets are not configured.');
  if (path === '/api/health' && method === 'GET') return json({ok: true, jevConfigured: Boolean(env.TYPESAFE_API_KEY), discordConfigured: discordConfigured(env)});
  if (path === '/api/discord/interactions' && method === 'POST') return handleInteraction(request, store, env);
  if (path === '/api/activity/config' && method === 'GET') return json(activityConfig(env));
  if (path === '/api/activity/session' && method === 'POST')
    return json(await createActivitySession(request, fields(await readBody(request), ['code']), store, env));
  if (path === '/api/auth/discord' && method === 'GET') return beginOAuth(request, store, env);
  if (path === '/api/auth/discord/callback' && method === 'GET') return finishOAuth(request, store, env);
  if (path === '/api/admin/analytics' && method === 'GET') return json(await adminAnalytics(request, url, store, env));
  if (path === '/api/me' && method === 'GET') {
    const ip = request.headers.get('CF-Connecting-IP') || env.LOCAL_CLIENT_IP || 'local';
    await store.limit('bootstrap:' + await sha256(env.APP_SIGNING_KEY + ip), 300, 3600);
    const {session, cookie} = await getSession(request, store, env, true);
    const user = session.user_id ? await store.get('SELECT id,display_name FROM users WHERE id=?', [session.user_id]) : null;
    const recent = await store.all(`SELECT id,status,created_at,mode,ranked,state_json FROM matches
      WHERE (user_id=? OR (user_id IS NULL AND session_id=?)) ORDER BY created_at DESC LIMIT 20`, [session.user_id, session.id]);
    const response = json({user, csrf: session.csrf, context: sessionContext(session), capabilities: {
      jev: Boolean(env.TYPESAFE_API_KEY), discord: discordConfigured(env), model: env.JEV_MODEL || DEFAULT_MODEL},
      matches: recent.map(m => ({id: m.id, status: m.status, createdAt: m.created_at, mode: m.mode, ranked: Boolean(m.ranked),
        humanScore: JSON.parse(m.state_json).human.score, jevScore: JSON.parse(m.state_json).jev.score})),
      activeMatchId: recent.find(m => m.status === 'active')?.id || null});
    if (cookie) response.headers.set('Set-Cookie', cookie); return response;
  }
  const {session} = await getSession(request, store, env);
  if (['POST', 'DELETE', 'PUT', 'PATCH'].includes(method)) requireWrite(request, session, env);
  if (path === '/api/logout' && method === 'POST') {
    await store.run('DELETE FROM sessions WHERE id=?', [session.id]);
    const response = json({ok: true}); response.headers.set('Set-Cookie', sessionCookie(env, '', 0)); return response;
  }
  if (path === '/api/context' && method === 'POST') {
    const body = fields(await readBody(request), ['launchToken']);
    return json({context: await consumeContext(body.launchToken, session, store, env)});
  }
  if (path === '/api/leaderboards' && method === 'GET') return json(await leaderboard(url, session, store, env));
  if (path === '/api/matches' && method === 'POST') {
    const ip = request.headers.get('CF-Connecting-IP') || env.LOCAL_CLIENT_IP || 'local';
    await store.limit('ip-starts:' + await sha256(env.APP_SIGNING_KEY + ip), 60, 3600);
    return json(await createMatch(fields(await readBody(request), ['difficulty', 'mode', 'ranked']), session, store, env), 201);
  }
  const match = /^\/api\/matches\/([a-f0-9]{32})(?:\/(step|control|events|bundle|analytics|telemetry|verify))?$/.exec(path);
  if (!match) throw new HttpError(404, 'Endpoint not found.');
  const [, id, action] = match;
  if (!action && method === 'GET') return json({match: await getMatch(id, session, store, env)});
  if (action === 'step' && method === 'POST') return json(await stepMatch(id,
    fields(await readBody(request), ['requestId', 'expectedRevision', 'humanAction']), session, store, env));
  if (action === 'control' && method === 'POST') {
    const body = fields(await readBody(request), ['action']); return json({match: await controlMatch(id, body.action, session, store)});
  }
  if (action === 'telemetry' && method === 'POST') return json(await telemetry(id,
    fields(await readBody(request), ['events']), session, store));
  const m = await ownedMatch(id, session, store);
  if (method !== 'GET') throw new HttpError(405, 'Method not allowed.');
  if (action === 'events') {
    const after = numberParam(url.searchParams, 'after', 0, 0, 1000000);
    const rows = await store.all('SELECT event_json FROM events WHERE match_id=? AND seq>? ORDER BY seq LIMIT 100', [id, after]);
    const events = rows.map(r => JSON.parse(r.event_json)), last = events.at(-1)?.seq || after;
    return json({events, nextAfter: last < m.event_seq ? last : null, head: m.event_head});
  }
  if (action === 'bundle' && url.searchParams.get('format') === 'jsonl') {
    // Paginated streaming avoids collecting the full evidence journal in the server heap.
    const encoder = new TextEncoder(); let after = 0, done = false;
    const stream = new ReadableStream({async pull(controller) {
      if (done) { controller.close(); return; }
      try {
        const rows = await store.all('SELECT seq,event_json FROM events WHERE match_id=? AND seq>? AND seq<=? ORDER BY seq LIMIT 50', [id, after, m.event_seq]);
        for (const row of rows) { controller.enqueue(encoder.encode(row.event_json + '\n')); after = row.seq; }
        if (rows.length < 50 || after >= m.event_seq) { done = true; controller.close(); }
      } catch (error) { controller.error(error); }
    }});
    return new Response(stream, {headers: {'Content-Type': 'application/x-ndjson', 'Content-Disposition': `attachment; filename="${id}-events.jsonl"`}});
  }
  if (action === 'verify') {
    return json(await verifyBundle({...await bundleMetadata(m, env), events: store.streamEvents(id, m.event_seq)}, {expectedHead:m.event_head}));
  }
  if (action === 'bundle') {
    const metadata = await bundleMetadata(m, env), encoder = new TextEncoder();
    async function* fragments() {
      yield JSON.stringify(metadata).slice(0,-1) + ',"events":[';
      let first = true;
      for await (const event of store.streamEvents(id, m.event_seq)) {
        yield (first ? '' : ',') + JSON.stringify(event); first = false;
      }
      yield '],"telemetry":['; first = true; let offset = 0;
      while (true) {
        const rows = await store.all('SELECT * FROM telemetry WHERE match_id=? ORDER BY received_at,id LIMIT 100 OFFSET ?', [id,offset]);
        for (const t of rows) {
          yield (first ? '' : ',') + JSON.stringify({id:t.id,receivedAt:t.received_at,type:t.type,data:JSON.parse(t.data_json)}); first = false;
        }
        if (rows.length < 100) break; offset += rows.length;
      }
      yield ']}';
    }
    const iterator = fragments(), stream = new ReadableStream({async pull(controller) {
      try { const next = await iterator.next(); if (next.done) controller.close(); else controller.enqueue(encoder.encode(next.value)); }
      catch (error) { controller.error(error); }
    }});
    return new Response(stream, {headers:{'Content-Type':'application/json', 'Content-Disposition':`attachment; filename="${id}-audit.json"`}});
  }
  if (action === 'analytics') {
    const bundle = await matchBundle(m, store, env);
    const result = analyze(bundle);
    if (url.searchParams.get('format') === 'csv') {
      const table = url.searchParams.get('table') || 'rounds';
      const rows = {rounds: result.roundRows, candidates: result.candidateRows, cells: result.cellRows}[table];
      if (!rows) throw new HttpError(400, 'Unknown analytics table.');
      return new Response(csv(rows), {headers: {'Content-Type': 'text/csv', 'Content-Disposition': `attachment; filename="${id}-${table}.csv"`}});
    }
    return json(result);
  }
  throw new HttpError(404, 'Endpoint not found.');
}
export async function handleApi(request, env) {
  const requestId = randomHex(12), start = performance.now(); let response;
  try { response = await route(request, env); }
  catch (error) {
    const status = error instanceof HttpError ? error.status : 500;
    response = json({error: error instanceof HttpError ? error.message : 'Internal error. No unverified score was accepted.',
      code: error.code || 'internal_error', requestId, ...(error.details ? {details: error.details} : {})}, status);
    if (status === 500) console.error(JSON.stringify({type: 'api_error', requestId, code: error.code || 'internal_error'}));
  }
  for (const [key, value] of Object.entries(HEADERS)) response.headers.set(key, value);
  response.headers.set('X-Request-ID', requestId);
  response.headers.set('Server-Timing', `api;dur=${(performance.now() - start).toFixed(1)}`);
  if (response.status === 429) response.headers.set('Retry-After', '60');
  return response;
}
export {HEADERS};
