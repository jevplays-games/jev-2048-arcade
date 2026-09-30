// Discord Activity support. Discord loads the game in an iframe on <application id>.discordsays.com, where a
// SameSite cookie is not sent, so the game signs the player in through the Embedded App SDK and then keeps a
// bearer session token in memory. Nothing here changes the normal browser sign-in.
import {randomHex, sha256} from '../public/core/crypto.js';
import {HttpError} from './db.js';
import {activityOrigin, discordConfigured, discordIdentity, upsertDiscordUser} from './auth.js';
export const ACTIVITY_SESSION_MS = 24 * 3600 * 1000;
// Discord shows an Activity inside its own iframe. Only a page loaded with Discord's frame_id may be framed, and only by Discord.
export const ACTIVITY_FRAME_ANCESTORS = 'frame-ancestors https://discord.com https://ptb.discord.com https://canary.discord.com';
export function activityConfig(env) {
  if (!discordConfigured(env)) throw new HttpError(503, 'Discord has not been configured by the host.', 'discord_not_configured');
  return {clientId: env.DISCORD_CLIENT_ID};
}
export async function createActivitySession(request, body, store, env) {
  if (!discordConfigured(env)) throw new HttpError(503, 'Discord has not been configured by the host.', 'discord_not_configured');
  const origin = request.headers.get('origin');
  if (!origin || (origin !== activityOrigin(env) && origin !== env.PUBLIC_ORIGIN)) throw new HttpError(403, 'Origin check failed.', 'csrf');
  const ip = request.headers.get('CF-Connecting-IP') || env.LOCAL_CLIENT_IP || 'local';
  await store.limit('activity-session:' + await sha256(env.APP_SIGNING_KEY + ip), 60, 3600);
  const {code} = body;
  if (typeof code !== 'string' || !code || code.length > 2048) throw new HttpError(400, 'Missing authorization code.', 'invalid_code');
  // An SDK authorization code is exchanged without a redirect URI.
  const {user, accessToken} = await discordIdentity(env, code, null);
  const now = Date.now(), fresh = randomHex(), csrf = randomHex();
  await store.batch([upsertDiscordUser(user, now),
    ['INSERT INTO sessions(id,user_id,csrf,created_at,expires_at) VALUES(?,?,?,?,?)', [await sha256(fresh), user.id, csrf, now, now + ACTIVITY_SESSION_MS]]]);
  // The Discord access token is returned once so the SDK can authenticate; it is never stored or logged.
  return {token: fresh, csrf, accessToken, user: {id: user.id, displayName: String(user.global_name || user.username || 'Player').slice(0, 100)}};
}
// Response headers for a static document. Only a frame_id document may be framed, and only by Discord.
export function documentHeaders(url, base) {
  const headers = {...base};
  if (url.searchParams.has('frame_id')) {
    delete headers['X-Frame-Options'];
    headers['Content-Security-Policy'] = base['Content-Security-Policy'].replace("frame-ancestors 'none'", ACTIVITY_FRAME_ANCESTORS);
  }
  return headers;
}
