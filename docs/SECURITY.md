# Security, privacy and operational boundaries

This is a tested implementation, not an independent security audit. Live identity/provider/deployment behavior must be checked in your own staging environment before accepting public ranked play.

## Implemented controls

Server-owned board state, legal actions, merge arithmetic, score verification and spawn derivation prevent a browser from directly submitting an invented score. Request IDs, revisions, durable pending actions and leases prevent ordinary replay/double-click/concurrent-tab duplication. Results are unique per match and inserted only after replay succeeds.

Production cookies are HTTP-only, SameSite=Lax, Secure, `__Host-` prefixed, and origin-bound. OAuth uses one-use expiring state bound to the initiating browser; successful login rotates the session. Browser mutations require the expected Origin and CSRF token. Local loopback development deliberately permits an HTTP cookie without Secure.

API request bodies and external response sizes are bounded; supported request fields, action IDs, telemetry types and quotas are validated. Names are rendered with `textContent`; SQL uses parameters. CSP restricts scripts and styles to the application origin, disallows framing and plugins, and avoids third-party assets. Quotas prevent a public arbitrary-purpose JEV proxy.

Discord interaction verification covers the timestamp plus the exact body bytes with Ed25519. Timestamp freshness, interaction deduplication, configured approved text channels, signed five-minute launch tokens, same-user binding and one-use nonce consumption are enforced. A fifteen-minute context grant is a recent launch-time proof, not live permission synchronization.

API/provider/Discord credentials are kept server-side. Stored active seeds are encrypted; local keys are generated privately, and are never part of an exported bundle. Structured logs omit request authorization headers, access tokens and raw identity responses. Provider evidence retains documented response fields rather than arbitrary top-level response metadata.

## Deliberate limits

- A valid replay proves the legal recorded game, not that a human acted without external automation or assistance.
- A seed commitment prevents changes after commitment; it does not prove that an operator never selected among candidate seeds before publishing it.
- A hash chain is relative to its trusted head. An operator with full database control can rewrite histories and hashes. Retain heads externally or use an independent signing/transparency system when stronger research assurance is required.
- The provider response is not independently signed. A genuine-looking HTTP fixture and a genuine provider response require an externally trustworthy run environment to distinguish. Synthetic examples are explicitly classified.
- Private threads, DMs and continuously refreshed Discord access controls are not implemented. Restrict the command to approved ordinary guild text channels.
- Anonymous rate limits are not a comprehensive anti-Sybil or DDoS defense. Add host-level protections for internet exposure.
- Expiry and some API/security rejection events are operational state/log information, not canonical match events.
- The deployment adapter, native browser CSP/cookie behavior, live Discord and live JEV have not been certified in this environment. Review staging behavior, permissions and provider contract before production.

## Data minimization and retention

Discord persistence is limited to ID, display name, avatar reference and timestamps; no email is requested. Matches hold the account/community association required for leaderboard attribution. Exports do not need those associations. Optional client timings are off by default and are distinct, untrusted telemetry. No advertising SDK, analytics beacon, fingerprinting package or external font is included.

Match history shown to an owner is bounded to the latest 20; that is a display limit, not deletion. Baseline samples contain no real people. Set a documented retention policy for your deployed service, including guest traces, opted-in telemetry and account erasure. The provided local maintenance tool defaults to dry run and does not run on a timer. It deletes dependent records in a transaction; user deletion is explicit and requires matching confirmation. Rate-limit records use mixed windows and are not expired by guessing their interpretation.

Keep a verified replay while its leaderboard result is retained. Deleting the replay and leaving a published result would make later verification impossible. Backups and independently retained heads can still contain prior personal data; include them in your retention/erasure process. The maintenance tool does not certify legal compliance.

## Safe operation

Back up database **and** encryption key together. Do not rotate the seed key without a migration, because existing seeds then become unreadable. Use HTTPS and explicit keys on public hosts; set PUBLIC_ORIGIN exactly. Never set DEV_LOCAL=true on a public Worker. Do not use TEST_MOVE_LIMIT in deployment.

Use the administrative analytics bearer secret only server-to-server or from a trusted operator shell, never in the public UI or browser storage. Keep developer command-registration credentials private. The ZIP excludes `.data`, `.env`, `.dev.vars`, dependencies and private keys.

Before public release: run the normal-browser tests on your origin, check Discord authorize/deny/reuse flows against a test guild, test provider error and billing behavior, confirm Cloudflare/D1 quotas when using the Worker, inspect live telemetry/retention, and obtain any security review appropriate to your exposure.
