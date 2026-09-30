# Discord Activity mode

Discord can launch the game as an Activity: an iframe on `https://<DISCORD_CLIENT_ID>.discordsays.com` that Discord proxies to the game host. The normal browser flow is unchanged; everything below applies only to documents loaded with Discord's `frame_id` query parameter.

## What differs inside an Activity

- **Sign-in.** The page calls the Embedded App SDK (`sdk.commands.authorize`, scope `identify`), posts the code to `POST /api/activity/session`, and the server exchanges it with the game's existing Discord client credentials **without a `redirect_uri`**. The user row is upserted exactly as in the OAuth callback. The response carries a bearer token, its CSRF token, and the Discord access token (returned once for `sdk.commands.authenticate`, never stored).
- **Bearer sessions.** The browser does not send the game's `SameSite=Lax` cookie in the iframe, so the client keeps the token in memory and sends `Authorization: Bearer <token>`. Only its SHA-256 is stored, in the same `sessions` table (lifetime 24 hours). Activity sessions do not preserve guest practice matches; a fresh session starts signed in.
- **Origin check.** Mutations normally require `Origin == PUBLIC_ORIGIN`. A request authenticated by a bearer token may alternatively come from `https://<DISCORD_CLIENT_ID>.discordsays.com`. Cookie sessions never get this exception, and CSRF is always required.
- **Framing.** The document is served with `frame-ancestors 'none'`. When the URL has `frame_id`, only that directive becomes `https://discord.com https://ptb.discord.com https://canary.discord.com`; the rest of the CSP is untouched. API responses are never frameable. For the Worker to see the `/` request, `wrangler.jsonc` sets `run_worker_first: ["/api/*", "/"]`. The local Node server applies the same rule.
- **Scripts.** The SDK is vendored at `public/vendor/discord-embedded-app-sdk.js` so `script-src 'self'` stays intact.

Endpoints: `GET /api/activity/config` (returns the public client id; 503 when Discord is unconfigured) and `POST /api/activity/session`.

## Developer Portal settings (manual)

1. Application settings: enable **Activities**.
2. Activities, URL Mappings: prefix `/` maps to `2048.jevplay.games` (the host in `PUBLIC_ORIGIN`, no scheme).
3. Add OAuth2 scope `identify` (already used by the web sign-in). No redirect URI is needed for Activity sign-in.
4. Enabling Activities makes Discord create a primary **Entry Point** command. Preserve it: `npm run discord:register` only POSTs the `/2048` command and does not bulk-overwrite, so it is safe. Any future switch to a bulk `PUT` must include the Entry Point command.

Ranked play, leaderboards and provenance are unchanged; the Activity is another way to hold a Discord-authenticated session.
