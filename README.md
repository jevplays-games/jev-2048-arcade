<p align="center"><img src="assets/banner.png" alt="Pink retro-desktop banner: the title Slide Score above two pixel windows labelled You and Jev, each showing a 4x4 tile board, beside a score chart window." width="100%"></p>

<div align="center">

# Slide Score

**Your board, Jev's board, the same spawns: a two-board duel on 2048 rules with every decision on the record.**

[![Play](https://img.shields.io/badge/play-slide--score.jevplay.games-F386A1?style=flat-square&labelColor=1E1E1E)](https://slide-score.jevplay.games)
[![Status](https://img.shields.io/badge/status-pre--release-E551BA?style=flat-square&labelColor=1E1E1E)](#quick-start)
[![Node](https://img.shields.io/badge/node-22.16%2B-F386A1?style=flat-square&labelColor=1E1E1E)](https://nodejs.org)
[![License](https://img.shields.io/badge/license-MIT-DEDEDE?style=flat-square&labelColor=1E1E1E)](LICENSE)

[Quick start](#quick-start) · [How it works](#how-it-works) · [Game semantics](#game-semantics) · [Analytics and replay](#analytics-and-replay) · [Discord and deployment](#discord-and-deployment) · [Layout](#repository-layout) · [Sources](#sources) · [Contributing](#contributing)

</div>

---

Slide Score is a single-page duel played by the rules of 2048. You and Jev each play your own 4×4 board, and both boards get the same hidden spawns. The server owns the rules and randomness, asks Jev typed `Score` questions about each candidate slide, and records every request, answer and transition, so a finished match can be replayed and verified offline.

> [!NOTE]
> Local heuristic practice works immediately, with no API keys or npm runtime dependencies. Live Jev and Discord require your own server-side credentials. No live Jev call, Discord authorization, or Cloudflare deployment was performed while producing this package. The provider examples are explicitly labeled synthetic; the included measured benchmark uses scripted baselines only.

![Slide Score in a desktop browser: your board and the local heuristic's board as grey pixel windows on pink, twenty moves into a practice duel.](docs/screenshots/desktop.png)

## Quick start

Requires **Node.js 22.16.0 or newer** with `node:sqlite` available. The tested version is 22.16.0. An experimental SQLite warning on that version is expected.

```sh
cd jev-slide-score
npm start
```

Open **http://127.0.0.1:8787**. No `npm install` is needed for local execution or the Node tests. Use that exact origin rather than changing between `localhost` and `127.0.0.1`; CSRF checks bind requests to the configured origin.

The server creates `.data/arcade.sqlite` and private local signing/encryption keys on first run. These files are not part of the distributed archive. Preserve the keys with your database to replay retained encrypted seeds. To reset only your development instance, stop the server and move its `.data` directory aside.

On Windows PowerShell, the same `npm start` command works. To configure credentials, use `Copy-Item .env.example .env`; on macOS/Linux use `cp .env.example .env`.

Opening `index.html` directly as a file is not supported: the included server supplies sessions, randomness, persistence, and opponent actions even in local practice.

### Live Jev

Create `.env` from `.env.example`, set `TYPESAFE_API_KEY`, and restart:

```dotenv
TYPESAFE_API_KEY=your-private-key
JEV_MODEL=jev-1.13.0
JEV_TIMEOUT_MS=10000
```

Choose **Jev** as the opponent and start a duel. The server calls the documented TypeSafe endpoint with typed Score questions. Do not put the key into browser files. The pinned model ID must exist in your account; `latest` aliases are rejected. The contract was checked against public documentation and mocked responses, not against a live account.

Jev receives only its own board, remaining move budget, legal candidate afterstates, exact features, and bounded lookahead summaries. It does not receive your identity, board, pending move, seed, or future spawn. Scores and arithmetic come from code. Jev rates merge structure, space recovery, and anchor stability.

A provider failure pauses the reserved round. Retry preserves the human action. “Continue as local practice” is explicit and permanently removes eligibility; it never silently substitutes a model. Forced moves require no provider request.

## How it works

```mermaid
%%{init: {"theme":"base","themeVariables":{"lineColor":"#E551BA","fontFamily":"Inter, sans-serif"}}}%%
flowchart LR
  Browser[Browser: vanilla UI and shared rules] -->|HTTPS actions and snapshots| Worker[Worker or Node server: sessions, rules, seed, replay]
  Worker -->|Typed Score questions| Jev[Jev API on TypeSafe]
  Worker -->|Matches, events, results| D1[(D1 or SQLite)]
  Worker <-->|OAuth and signed interactions| Discord[Discord]
  classDef pink fill:#F386A1,stroke:#1E1E1E,color:#1E1E1E
  classDef ink fill:#1E1E1E,stroke:#1E1E1E,color:#FEFEFE
  classDef grey fill:#DEDEDE,stroke:#1E1E1E,color:#1E1E1E
  class Browser pink
  class Worker ink
  class Jev,D1,Discord grey
```

| Area | Included behavior |
|---|---|
| Game | Separate 4×4 boards; identical starts; once-per-move merges; conventional merge score; one successful move per active board per round; matched spawns; 2,048-move cap; blocked-board continuation |
| Controls | Arrow keys/WASD in the focused play area, directional buttons, swipe gestures, immediate deterministic move preview |
| Opponents | Explicit local heuristic practice; live Jev adapter; Easy/Normal/Hard/Jev evaluation profiles; forced legal moves; bounded retry and pause; irreversible unranked downgrade |
| Evidence | Versioned manifests; exact requests and documented response fields; candidate features; rubric scores/probabilities; selected action; timing; usage; source labels |
| Integrity | Secret-seed commitment; encrypted active seed; append-only application journal; SHA-256 chain; causal parent references; server-owned transitions; replay before leaderboard publication |
| Identity | Discord authorization-code login; browser-bound one-use OAuth state; secure production cookies; minimal `identify` scope |
| Community | Signed and verified `/2048` guild-channel launch; same-user one-use token; approved text-channel allowlist; Channel/Server/World leaderboards |
| Analytics | Per-actor move and board statistics, candidate tables, heatmaps, score curves, uncertainty/latency summaries, usage completeness, retries/failures, heuristic comparison proxies |
| Portability | JSON audit bundle; JSONL event journal; CSV/JSONL analysis tables; optional Parquet conversion; offline verifier/exporter; paired-seed benchmark |
| Hosting | Built-in Node/SQLite server; Cloudflare Worker/Static Assets/D1 adapter and migration; optional Dockerfile |

There is no browser framework, tracking SDK, game engine, ORM, or npm runtime dependency. Optional development/deployment tools are explained below.

See [architecture](docs/ARCHITECTURE.md) for the protocol and trust boundaries.

## Game semantics

Slide equal tiles together; each tile merges at most once per move. A successful move adds one tile: 2 with probability 0.9, or 4 with probability 0.1. An ineffective direction advances neither board. Reaching 2048 records a milestone but does not end the duel.

Both boards receive the same spawn value and the same uniformly shuffled position priority. The tile goes into each board's first empty cell in that priority. This preserves legal, uniform spawning even after the boards diverge. It does not force identical coordinates into differently occupied boards.

Higher final merge score wins. Equal scores draw. A blocked board freezes while the other continues. The declared ranked variant caps each board at 2,048 successful moves. There is no undo, speed bonus, hidden tiebreaker, or special attack mechanic. Resignation/expiry never publishes a high score.

Local practice is **not Jev**. Its UI and records say so. Difficulty controls its candidate-analysis depth, but its fallback move ordering remains deterministic; the four advertised Jev profiles use their own model rubric/depth configuration.

## Analytics and replay

Open **Analytics** for score/space/latency curves, per-player statistics and heatmaps. Open **Decision evidence** for current legal candidates and structured model outputs. **Replay & audit** supports round-by-round inspection, verification, importing a bundle, and exports.

```sh
# Check an exported audit without contacting Jev or Discord.
npm run verify -- path/to/audit.json

# Produce normalized CSV/JSONL tables and a derived summary.
npm run export -- path/to/audit.json output-directory

# Optional: requires pyarrow, not required to play or export CSV/JSONL.
python scripts/to_parquet.py output-directory
```

The JSON bundle includes a revealed seed only after the match becomes inactive. An active export can verify recorded transitions and hash consistency, but cannot independently reconstruct the still-hidden spawn stream. The JSONL journal is an event stream, not a substitute for the complete bundle metadata/terminal seed.

See [the analytics dictionary](docs/ANALYTICS.md), [architecture](docs/ARCHITECTURE.md), and [security boundaries](docs/SECURITY.md). Model confidence is not a win probability; heuristic “regret” is a proxy, not an optimal-play guarantee; missing token usage remains unknown. Optional browser timing is off by default and is always labeled untrusted.

## Discord and deployment

See [DEPLOYMENT.md](docs/DEPLOYMENT.md) for OAuth redirect configuration, the application command, approved channels, Node HTTPS hosting, and Cloudflare setup. There are no embedded secrets or default real community IDs.

The account login uses `identify`. Guild/channel association is established separately by a signature-verified interaction and a short-lived launch token bound to the same Discord user. Browser-supplied community IDs are never accepted as proof. Community entitlement is recent launch-time context, not a continuously synchronized permission model.

Ranked play requires both Discord login and live Jev. Guests can practice and read the World leaderboard. Signing in never retroactively upgrades a guest match.

### Tests and examples

```sh
npm test
npm run test:coverage
npm run bench -- --seeds 5 --moves 128 --policies random,greedy,heuristic
```

`examples/baseline-smoke` contains **nine actually executed, verified baseline runs**: three seeds × three scripted policies, capped at 64 moves. It demonstrates the benchmark and evidence pipeline, not Jev quality. `examples/mock-provider` contains a **four-round synthetic provider-contract fixture**, deliberately labeled throughout. Its generated probability distributions and token counts are not model measurements.

See [BENCHMARKS.md](docs/BENCHMARKS.md) and [VALIDATION.md](docs/VALIDATION.md) for exact boundaries and commands. The optional browser tests need Python Playwright and Chromium; they are not runtime dependencies.

### Operations and limits

Keep `.env`, `.dev.vars`, `.data`, and database backups private. Use a durable volume and HTTPS for public Node hosting. The maintenance CLI defaults to dry run; inspect it before applying retention/deletion. Preserve a replay as long as its result remains published.

```sh
npm run maintenance -- --db .data/arcade.sqlite
npm run maintenance -- --db .data/arcade.sqlite --guest-days 30 --apply
# Explicit account erasure, after backing up and stopping the server:
npm run maintenance -- --db .data/arcade.sqlite --delete-user DISCORD_ID --confirm DISCORD_ID --apply
```

Audit download and verification use paged event streaming on the server. Full analytics and browser imports still materialize the trace; use offline export for very long sessions. This release is tested application source, not a claim of independently audited production security or live deployment certification.

## Repository layout

```text
assets/              README banner and social preview; assets/src holds their HTML sources and render scripts
public/              Vanilla UI and shared pure rules, RNG, evaluation, audit, analytics
public/brand/        Shared jevplay.games brand system (pink/ink), Inter and VT323 fonts (SIL OFL 1.1)
server/              Native Node adapter, Worker adapter, trusted API, Jev, Discord, SQLite
migrations/          Database schema, indexes, sequence guard
scripts/             Offline verification/export, optional Parquet, secrets, maintenance
bench/               Paired-seed experiment runner with durable per-run evidence
tests/               Rules, API, model contracts, security, analytics, rename compatibility, optional browser tests
examples/            Clearly classified baseline measurements and mocked provider example
docs/                Architecture, analytics dictionary, deployment, security, validation
SOURCE_MANIFEST.json Source-input hashes; generated build identity is embedded in matches
```

## Sources

Slide Score is a two-board duel built on the rules of 2048 by Gabriele Cirulli; no 2048 code or art was copied. See [SOURCES.md](docs/SOURCES.md) and [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).

## Contributing

Issues and pull requests are welcome. Run `npm test` before opening a pull request, keep `game: '2048'` and other stored identifiers stable (old replays and launch proofs must keep verifying), and when sources change, regenerate `SOURCE_MANIFEST.json` with `npm run fingerprint` and refresh `SHA256SUMS.txt` (one `sha256  path` line per tracked file except itself).

---

<div align="center"><sub>A jevplay.games game · Steward: CompleteTech LLC · MIT licensed<br>Not an official TypeSafe AI publication; the pink, ink and pixel-window styling is a nod to typesafe.ai. Jev, System One and TypeSafe are their respective owners' names.</sub></div>
