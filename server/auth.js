import {randomHex, sha256, signToken, verifyToken, unhex} from '../public/core/crypto.js';
import {HttpError} from './db.js';
export const SESSION_MS = 7 * 24 * 3600 * 1000;
function cookieName(env) { return env.DEV_LOCAL === 'true' ? 'jev_session' : '__Host-jev_session'; }
export function sessionCookie(env, token, maxAge = SESSION_MS / 1000) {
  return `${cookieName(env)}=${token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAge}${env.DEV_LOCAL === 'true' ? '' : '; Secure'}`;
}
export const activityOrigin = env => /^\d{5,25}$/.test(env.DISCORD_CLIENT_ID || '') ? `https://${env.DISCORD_CLIENT_ID}.discordsays.com` : null;
// Inside a Discord Activity the browser will not send our SameSite cookie, so the game holds the session token in memory.
function bearerToken(request) { const m = /^Bearer ([a-f0-9]{64})$/.exec(request.headers.get('authorization') || ''); return m ? m[1] : null; }
export async function getSession(request, store, env, create = false) {
  const cookies = Object.fromEntries((request.headers.get('cookie') || '').split(';').filter(x => x.includes('='))
    .map(x => { const at = x.indexOf('='); return [x.slice(0, at).trim(), x.slice(at + 1)]; }));
  const bearer = bearerToken(request), token = bearer || cookies[cookieName(env)];
  if (token && /^[a-f0-9]{64}$/.test(token)) {
    const s = await store.get('SELECT * FROM sessions WHERE id=? AND expires_at>?', [await sha256(token), Date.now()]);
    if (s) return {session: bearer ? {...s, via: 'bearer'} : s, cookie: null};
  }
  if (!create) throw new HttpError(401, 'Session expired. Reload the page.', 'session_required');
  const fresh = randomHex(), id = await sha256(fresh), csrf = randomHex();
  const now = Date.now();
  await store.run('INSERT INTO sessions(id,user_id,csrf,created_at,expires_at) VALUES(?,NULL,?,?,?)', [id, csrf, now, now + SESSION_MS]);
  return {session: {id, user_id: null, csrf, context_json: null, created_at: now, expires_at: now + SESSION_MS}, cookie: sessionCookie(env, fresh)};
}
export function requireWrite(request, session, env) {
  const origin = request.headers.get('origin'), framed = session.via === 'bearer' ? activityOrigin(env) : null;
  if ((origin !== env.PUBLIC_ORIGIN && !(framed && origin === framed)) || request.headers.get('x-csrf-token') !== session.csrf)
    throw new HttpError(403, 'Origin or CSRF check failed.', 'csrf');
}
export function discordConfigured(env) { return Boolean(env.DISCORD_CLIENT_ID && env.DISCORD_CLIENT_SECRET); }
export async function beginOAuth(request, store, env) {
  if (!discordConfigured(env)) throw new HttpError(503, 'Discord OAuth has not been configured by the host.', 'discord_not_configured');
  const {session, cookie} = await getSession(request, store, env, true);
  const state = randomHex();
  await store.run('INSERT INTO proofs(id,kind,session_id,payload_json,expires_at) VALUES(?,?,?,?,?)',
    [await sha256(state), 'oauth', session.id, '{}', Date.now() + 600000]);
  const url = new URL('https://discord.com/oauth2/authorize');
  url.search = new URLSearchParams({client_id: env.DISCORD_CLIENT_ID, response_type: 'code',
    redirect_uri: env.PUBLIC_ORIGIN + '/api/auth/discord/callback', scope: 'identify', state}).toString();
  return new Response(null, {status: 302, headers: {Location: url.toString(), ...(cookie ? {'Set-Cookie': cookie} : {})}});
}
// Exchanges an authorization code for the verified Discord identity. The OAuth redirect flow passes its
// redirect_uri; the Embedded App SDK's code is exchanged without one.
export async function discordIdentity(env, code, redirectUri) {
  const fetcher = env.FETCH || fetch;
  const form = {client_id: env.DISCORD_CLIENT_ID, client_secret: env.DISCORD_CLIENT_SECRET, grant_type: 'authorization_code', code};
  if (redirectUri) form.redirect_uri = redirectUri;
  const response = await fetcher('https://discord.com/api/v10/oauth2/token', {method: 'POST',
    headers: {'Content-Type': 'application/x-www-form-urlencoded'},
    body: new URLSearchParams(form), signal: AbortSignal.timeout(10000)});
  if (!response.ok) throw new HttpError(502, 'Discord authorization failed. Start login again.');
  const tokens = await response.json();
  if (typeof tokens.access_token !== 'string') throw new HttpError(502, 'Discord returned no access token.');
  const identityResponse = await fetcher('https://discord.com/api/v10/users/@me', {
    headers: {Authorization: `Bearer ${tokens.access_token}`}, signal: AbortSignal.timeout(10000)});
  if (!identityResponse.ok) throw new HttpError(502, 'Discord identity could not be verified.');
  const user = await identityResponse.json();
  if (!/^\d{5,24}$/.test(user.id)) throw new HttpError(502, 'Invalid Discord identity.');
  return {user, accessToken: tokens.access_token};
}
export function upsertDiscordUser(user, now) {
  const name = String(user.global_name || user.username || 'Player').slice(0, 100);
  return [`INSERT INTO users(id,display_name,avatar,created_at,last_seen_at) VALUES(?,?,?,?,?) ON CONFLICT(id)
      DO UPDATE SET display_name=excluded.display_name,avatar=excluded.avatar,last_seen_at=excluded.last_seen_at`,
    [user.id, name, typeof user.avatar === 'string' ? user.avatar.slice(0, 128) : null, now, now]];
}
export async function finishOAuth(request, store, env) {
  const {session} = await getSession(request, store, env), url = new URL(request.url);
  const state = url.searchParams.get('state'), code = url.searchParams.get('code');
  if (!state || !/^[a-f0-9]{64}$/.test(state) || !code || code.length > 2048) throw new HttpError(400, 'Missing OAuth code/state.');
  const proof = await store.get(`UPDATE proofs SET consumed_at=? WHERE id=? AND kind='oauth' AND session_id=?
    AND expires_at>? AND consumed_at IS NULL RETURNING id`, [Date.now(), await sha256(state), session.id, Date.now()]);
  if (!proof) throw new HttpError(403, 'OAuth state is expired, already used, or bound to another browser.', 'oauth_state');
  const {user} = await discordIdentity(env, code, env.PUBLIC_ORIGIN + '/api/auth/discord/callback'), now = Date.now();
  const fresh = randomHex(), id = await sha256(fresh), csrf = randomHex();
  await store.batch([
    upsertDiscordUser(user, now),
    ['INSERT INTO sessions(id,user_id,csrf,created_at,expires_at) VALUES(?,?,?,?,?)', [id, user.id, csrf, now, now + SESSION_MS]],
    // Preserve ownership of guest practice without upgrading its eligibility.
    ['UPDATE matches SET session_id=? WHERE session_id=? AND user_id IS NULL', [id, session.id]],
    ['DELETE FROM sessions WHERE id=?', [session.id]]
  ]);
  return new Response(null, {status: 302, headers: {Location: env.PUBLIC_ORIGIN + '/', 'Set-Cookie': sessionCookie(env, fresh)}});
}
export async function handleInteraction(request, store, env) {
  if (!env.DISCORD_PUBLIC_KEY) throw new HttpError(503, 'Discord interactions are not configured.');
  const timestamp = request.headers.get('x-signature-timestamp'), signature = request.headers.get('x-signature-ed25519');
  if (!timestamp || !/^\d+$/.test(timestamp) || Math.abs(Date.now() / 1000 - Number(timestamp)) > 300 ||
      !signature || !/^[a-f0-9]{128}$/i.test(signature)) throw new HttpError(401, 'Invalid interaction signature.');
  const reader = request.body?.getReader(), parts = []; let size = 0;
  if (reader) while (true) {
    const chunk = await reader.read(); if (chunk.done) break;
    size += chunk.value.byteLength;
    if (size > 65536) { await reader.cancel(); throw new HttpError(413, 'Interaction too large.'); }
    parts.push(chunk.value);
  }
  const raw = new Uint8Array(size); let offset = 0;
  for (const part of parts) { raw.set(part, offset); offset += part.byteLength; }
  const body = new TextDecoder('utf-8', {fatal: true}).decode(raw);
  let valid = false;
  try {
    const key = await crypto.subtle.importKey('raw', unhex(env.DISCORD_PUBLIC_KEY), 'Ed25519', false, ['verify']);
    valid = await crypto.subtle.verify('Ed25519', key, unhex(signature), new TextEncoder().encode(timestamp + body));
  } catch { /* Never fall back to unsigned requests. */ }
  if (!valid) throw new HttpError(401, 'Invalid interaction signature.');
  const interaction = JSON.parse(body);
  if (interaction.type === 1) return Response.json({type: 1});
  if (interaction.type !== 2 || interaction.data?.name !== '2048' || !interaction.guild_id ||
      !interaction.channel_id || !interaction.member?.user?.id || (interaction.channel?.type ?? 0) !== 0)
    return Response.json({type: 4, data: {flags: 64, content: 'Use /2048 in an approved server text channel.'}});
  const allowed = (env.DISCORD_ALLOWED_CHANNELS || '').split(',').map(s => s.trim()).filter(Boolean);
  if (!allowed.includes(`${interaction.guild_id}:${interaction.channel_id}`))
    return Response.json({type: 4, data: {flags: 64, content: 'This channel is not enabled by the arcade host.'}});
  const payload = {v: 1, aud: 'jev-2048', sub: interaction.member.user.id, guildId: interaction.guild_id,
    channelId: interaction.channel_id, nonce: randomHex(16), exp: Date.now() + 300000};
  try {
    await store.run('INSERT INTO proofs(id,kind,payload_json,expires_at) VALUES(?,?,?,?)',
      ['interaction:' + interaction.id, 'interaction', '{}', Date.now() + 600000]);
  } catch { throw new HttpError(409, 'Interaction was already processed.'); }
  const token = await signToken(env.APP_SIGNING_KEY, payload);
  return Response.json({type: 4, data: {flags: 64, content: 'Play 2048 on your own board against JEV.',
    components: [{type: 1, components: [{type: 2, style: 5, label: 'Play 2048 vs JEV',
      url: env.PUBLIC_ORIGIN + '/#launch=' + token}]}]}});
}
export async function consumeContext(token, session, store, env) {
  if (!session.user_id) throw new HttpError(401, 'Sign in with the Discord account that launched this game.', 'login_required');
  let payload;
  try { payload = await verifyToken(env.APP_SIGNING_KEY, token); } catch { throw new HttpError(403, 'Launch token is invalid or expired.'); }
  if (payload.aud !== 'jev-2048' || payload.v !== 1 || payload.sub !== session.user_id ||
      !/^\d{5,24}$/.test(payload.guildId) || !/^\d{5,24}$/.test(payload.channelId) || !/^[a-f0-9]{32}$/.test(payload.nonce))
    throw new HttpError(403, 'Launch token does not match this Discord account.');
  const context = {guildId: payload.guildId, channelId: payload.channelId, subject: session.user_id, expiresAt: Date.now() + 900000};
  try {
    await store.batch([
      ['INSERT INTO proofs(id,kind,payload_json,expires_at,consumed_at) VALUES(?,?,?,?,?)',
        ['launch:' + payload.nonce, 'launch', JSON.stringify(context), context.expiresAt, Date.now()]],
      ['UPDATE sessions SET context_json=? WHERE id=?', [JSON.stringify(context), session.id]]
    ]);
  } catch { throw new HttpError(409, 'Launch token was already consumed.'); }
  return context;
}
export function sessionContext(session) {
  if (!session.context_json) return null;
  const c = JSON.parse(session.context_json);
  return c.expiresAt > Date.now() && c.subject === session.user_id ? c : null;
}
