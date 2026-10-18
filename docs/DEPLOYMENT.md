# Running and deployment

## Native Node: the fully exercised runtime

Use Node 22.16.0+ with built-in SQLite. No npm runtime dependency installation is required.

```sh
npm start
```

Defaults: loopback address 127.0.0.1, port 8787, origin http://127.0.0.1:8787, SQLite in `.data`, generated private local keys. `.env` is loaded by the npm script; starting `node server/local.js` directly uses only the process environment.

For public deployment put the server behind HTTPS, preserve a writable durable data volume, and set:

```dotenv
HOST=0.0.0.0
PORT=8787
PUBLIC_ORIGIN=https://your-arcade.example
DATA_DIR=/var/lib/jev-arcade
APP_SIGNING_KEY=<64 lowercase hexadecimal characters>
SEED_ENCRYPTION_KEY=<64 lowercase hexadecimal characters>
```

Generate new keys with `npm run secrets`. Do not paste generated secrets into source control. The third generated key may be used as ADMIN_API_KEY. Configure your reverse proxy to preserve Origin and streaming responses. The local adapter does not trust a browser's forwarding header as a client IP; behind a proxy its coarse anonymous quota may apply to the proxy address. Add edge rate controls appropriate to your host.

The Dockerfile is optional and was not built in this environment. It uses Node's built-in server and expects a `/data` volume. Pass credentials through your orchestrator's secret mechanism; `.dockerignore` excludes local secrets.

## TypeSafe/Jev

Set TYPESAFE_API_KEY and a versioned JEV_MODEL, initially `jev-1.13.0`. The endpoint is `https://api.typesafe.ai/v1/systemone`; the server uses Bearer authentication and structured Score questions. Verify that this model is available for your account. No fallback alias is silently used.

Default per-call timeout: ten seconds, at most two attempts. A long Retry-After request causes a pause instead of violating the provider's requested interval. Daily provider quotas default to 10,000 globally, 600 for an anonymous session and 6,000 for an authenticated user; starts and steps have independent bounds. These are application controls, not guarantees about billed charges.

## Discord application

Create/use your own Discord application. This package does not create an application or install itself into a guild.

1. Add the exact OAuth redirect: `https://your-host/api/auth/discord/callback`. Local staging may use the explicitly configured allowed redirect for its origin. Set DISCORD_CLIENT_ID and DISCORD_CLIENT_SECRET server-side.
2. Login uses `identify` only; it does not request email, guild listing or a privileged bot permission.
3. Configure the interaction endpoint `https://your-host/api/discord/interactions`, set the application's verification public key in DISCORD_PUBLIC_KEY, and complete Discord's PING/signature check.
4. Enable guild installation with the `applications.commands` scope. A continuously connected bot user is not required for this HTTP interaction design.
5. Register only the `/2048` command (Slide Score keeps this command name; the handler also accepts `/slide-score`) using `npm run discord:register`. Optional DISCORD_TEST_GUILD_ID registers a test-guild command first. The script uses client credentials with `applications.commands.update` and does not bulk-overwrite unrelated commands.
6. Set DISCORD_ALLOWED_CHANNELS to comma-separated `guild-id:channel-id` pairs. Only ordinary guild text channels in this allowlist can issue game launch links.
7. Invoke `/2048` in a test channel, follow the ephemeral link, and log in as the invoking account. Forwarding that token to a different account must fail.

A successful login alone gives World eligibility. A current signed channel launch adds Server/Channel attribution when a **new ranked Jev match** is created. It does not upgrade earlier guest or local matches. Context expires after fifteen minutes for new use, while existing match attribution is retained.

## Cloudflare Worker, Static Assets and D1

This adapter and schema are supplied, but a Cloudflare account/deployment was not available for live verification. Wrangler is an optional deployment tool, not a runtime dependency. Review a current compatible Wrangler release and pin it in your own deployment lockfile before production.

From the project directory, using an authenticated Wrangler installation:

```sh
npx wrangler d1 create jev-2048
```

The D1 database keeps its original name `jev-2048` after the rename to Slide Score (owner decision 2026-10-14; D1 databases cannot be renamed, and no data migration is needed). Copy the returned database ID into `wrangler.jsonc`, replacing the explicit placeholder. Set PUBLIC_ORIGIN to the exact deployed HTTPS URL (production: `https://slide-score.jevplay.games`); keep DEV_LOCAL unset/false.

`LEGACY_PUBLIC_ORIGINS` lists old origins the same Worker keeps answering on (production: `https://2048.jevplay.games`). Each host is self-contained: a write must carry the Origin of the host it is sent to, and Discord OAuth uses that host's own `/api/auth/discord/callback`, so register both callback URLs in the Discord portal until the old host becomes a 301 redirect. Session cookies are host-only, so players moving from the old host to the new one sign in once and lose local preferences (`telemetry`, `lastMatch`, `difficulty`) once. Apply the migration:

```sh
npx wrangler d1 migrations apply jev-2048 --remote
```

Store credentials using the interactive secret facility, not command arguments containing the values:

```sh
npx wrangler secret put APP_SIGNING_KEY
npx wrangler secret put SEED_ENCRYPTION_KEY
npx wrangler secret put TYPESAFE_API_KEY
npx wrangler secret put DISCORD_CLIENT_ID
npx wrangler secret put DISCORD_CLIENT_SECRET
npx wrangler secret put DISCORD_PUBLIC_KEY
npx wrangler secret put ADMIN_API_KEY
npx wrangler deploy
```

Discord IDs/public key are not confidential like client secrets, but centralizing them as server configuration is convenient. Omit integrations not being enabled. `public/_headers` supplies the static security headers when assets are served before the Worker; API responses set the headers themselves. `worker.js` shares all match/auth/verification logic with the tested Node path.

The included CPU limit of 30,000 ms requires a compatible plan; confirm your plan's limits rather than assuming it is available. D1's transactional batch rolls back on SQL failure; the lease predicate is arranged to cause an actual failing insertion when it is no longer valid. This behavior is exercised through the local transactional adapter, not a live D1 instance.

## Memory and storage planning

Detailed raw responses plus candidate/board data can produce large traces. The supplied 64-move baseline sample is intentionally much smaller than a 2,048-move native-Jev session. Server-side full JSON exports and replay verification read bounded event pages. The normal analytics endpoint still materializes the trace and derived cell/candidate tables, and browser inspection must parse the JSON.

For high-volume or long-trace research use, prefer the Node service with adequate memory and run offline exports; treat Worker analytics memory limits as a staging/load-test requirement. Do not claim a production capacity from the small included smoke experiment. Keep D1 row sizes, statement limits, read/write costs and storage retention under observation.

## Backups, retention and health

`GET /api/health` is a lightweight liveness/capability endpoint, not a provider request. `GET /api/admin/analytics` requires `Authorization: Bearer <ADMIN_API_KEY>` and returns aggregated cohort/event/usage data. It does not enumerate player names or private channel IDs.

Stop the Node service before running destructive local maintenance and back up first:

```sh
npm run maintenance -- --db .data/arcade.sqlite
npm run maintenance -- --db .data/arcade.sqlite --guest-days 30 --apply
```

The first command is dry run; the second removes expired proof/session data and old inactive/expired guest histories. It does not delete verified registered-user histories by age. Explicit account erasure requires `--delete-user ID --confirm ID --apply`. The tool operates on local SQLite files, not directly on D1. Use an appropriately reviewed remote retention process for D1 rather than pretending the local command manages it.

Release changes should regenerate `npm run fingerprint`, preserve old replay versions, and archive the matching source identity. Secrets and mutable database files are never source-fingerprinted or included in the ZIP.

## GoDaddy Node hosting

The same `server/local.js` entry runs as a plain Node.js app (`npm run build` is a no-op, `npm start` loads `.env` via `--env-file-if-exists=.env`). Zip layout: repository root files (`package.json`, `server/`, `public/`, `migrations/`, `.env`) at the zip root.

- The platform injects `PORT`; set `HOST=0.0.0.0` (the shim defaults to loopback otherwise). Set `PUBLIC_ORIGIN=https://slide-score.jevplay.games`; a non-loopback origin turns `DEV_LOCAL` off, so ranked play, Discord interactions and Discord sign-in behave as on the Worker, and startup fails unless `APP_SIGNING_KEY` and `SEED_ENCRYPTION_KEY` (64 hex characters, `npm run secrets`) are configured.
- Other keys: `TYPESAFE_API_KEY`, `JEV_MODEL`, `JEV_TIMEOUT_MS`, `JEV_REQUESTS_PER_DAY`, `DISCORD_CLIENT_ID`, `DISCORD_CLIENT_SECRET`, `DISCORD_PUBLIC_KEY`, `DISCORD_ALLOWED_CHANNELS` (empty rejects all interactions), optional `ADMIN_API_KEY`. Real process env vars override `.env`.
- Set `TRUST_PROXY=1` behind the platform's single reverse proxy so per-client quotas use the last `X-Forwarded-For` entry; otherwise all clients share the proxy address. CSRF/origin checks are unchanged: the request must carry the Origin of the host it was sent to, which must be `PUBLIC_ORIGIN` or one of `LEGACY_PUBLIC_ORIGINS`.
- SQLite lives in `DATA_DIR` (default `.data/arcade.sqlite`, outside `public/`, never served). Storage is ephemeral: matches and analytics are lost on redeploy. There are no scheduled jobs; run `npm run maintenance` manually if needed.

### Continuous deployment

`.github/workflows/deploy.yml` runs on every push to `main` (and manually via **Run workflow**): it runs `npm test`, zips the committed runtime files (`package.json`, `package-lock.json`, `server/`, `public/`, `migrations/`) with `git archive`, and `scripts/godaddy-deploy.js` uploads the zip through the GoDaddy Hosting API (`https://api.godaddy.com/v1/hosting`), waits for the import, then deploys it to the published app. A failed test, import or build stops the run and leaves the live app unchanged.

One-time setup:

- Create a Personal Access Token at https://developer.godaddy.com/personal-access-token with `hosting.application:read`, `hosting.source:write` and `hosting.deployment:execute`, and store it as the repository (or `production` environment) secret `GODADDY_PAT`. Tokens expire; renew the secret before the expiry date.
- The workflow targets app `NODEJS-cthdfczuwe` (jev-2048; API app IDs carry the `NODEJS-` prefix). Set the repository variable `GODADDY_APP_ID` to deploy a different app.
- Runtime configuration is not in the zip: set `HOST`, `PUBLIC_ORIGIN`, `TRUST_PROXY`, the signing/encryption keys and the integration keys under the app's **Settings → Secrets** for both Preview and Publish.

To deploy from a workstation instead, put `GODADDY_PAT` in `.env` (`GODADDY_APP_ID` is preset in `.env.example`), then: `git archive --format=zip -o deploy.zip HEAD package.json package-lock.json server public migrations && npm run deploy:godaddy -- deploy.zip`.
