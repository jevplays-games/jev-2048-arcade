# Analytics and evidence dictionary

## Scope and trust

Analytics version: `analytics-v1`. Every number must be traceable to a recorded observation, deterministic calculation, provider response, or explicitly untrusted client measurement. Analytics do not add model calls or change selected moves. Exact human comparison candidates are calculated after the actions are chosen; this overhead is measured separately.

There are three distinct evidence classes in this package:

1. `server-recorded`: actual app sessions, possibly local or JEV according to the manifest and each move source. This label alone does not prove that an external provider is genuine.
2. `scripted-baseline-benchmark`: actual measured baseline experiments with no live JEV requests.
3. `mocked-provider-contract-fixture`: synthetic provider responses used to exercise the contract/export pathway. Their confidence, usage, and latency are not JEV measurements.

A match manifest binds rules, RNG, difficulty, complete profile configuration, policy version, model ID, move cap, original eligibility/mode, creation time, build hash, and evidence classification. The user's Discord identity and community IDs are not sent to JEV and are not necessary in exported decision evidence.

## Event envelope

Every authoritative journal event has:

| Field | Meaning |
|---|---|
| `schemaVersion` | Envelope schema, currently 1 |
| `matchId`, `seq` | Match identity and strictly increasing sequence |
| `type` | Explicit operation/event type |
| `occurredAt` | UTC ISO timestamp |
| `clockId`, `monotonicMs` | Monotonic clock value, comparable only within the same clock domain |
| `parentSeq` | Earlier causal parent where one is recorded; normal round events reference their reservation |
| `data` | Event-specific payload, described below |
| `prevHash`, `hash` | SHA-256 chain over canonical, sorted-key JSON |

The event hash includes the envelope excluding only `hash`. The first previous hash is 64 zeroes. A trusted externally retained head strengthens tamper detection. A party who controls the complete database and export can rewrite and rehash an entire history; hashing is not a provider signature or an operator-proof audit.

SQLite application writes use transactions, WAL, and `synchronous=FULL`. Benchmark JSONL writes call `fsync` after each emitted event. D1 uses its transactional batch interface. The application never updates an existing event during ordinary operations, although an administrator still controls the database and explicit erasure removes affected histories.

## Event vocabulary

| Event | Recorded content and interpretation |
|---|---|
| `match_started` | Bound manifest, initial exponent cells, seed commitment |
| `round_reserved` / `round_resumed` | Request ID, expected revision, locked human direction; resumption is not a fresh human choice |
| `candidates_generated` | Own-board state hash, complete legal root candidates and computed features |
| `jev_requested` | Attempt number, request hash, exact structured request before dispatch; no authorization header |
| `jev_response` | Attempt, request hash, HTTP status, bytes, elapsed latency, documented model/answers/usage fields |
| `jev_failed` | Attempt, normalized failure code, latency; raw secret-bearing error text is not required |
| `decision_selected` | Chosen action, source, board hash, request linkage/confidence where applicable |
| `round_committed` | Actions, full resulting state, spawn event, merge/movement details, complete accepted decision, human comparison candidates, pre/post hashes, timing |
| `round_paused` | Failure reason after which the reserved action remains locked |
| `practice_enabled` | Explicit irreversible downgrade, previous mode and eligibility |
| `match_resigned` | User-controlled stop; no official high score |
| `match_verified` | Verified replay head, round count, seed status, native decision count, eligibility decision |
| `result_published` | Verified partition, score, result, scope categories, not private channel IDs |
| `verification_failed` | Replay mismatch status; no publication |
| `run_failed` | Benchmark failure retained in the experiment, not silently dropped |

Expiration is an operational database status, not currently a dedicated journal event. Request-bound authentication/CSRF/rate-limit rejections are API responses, not appended to a match the request may not own. Server logs record normalized internal errors and request IDs. Do not interpret the match journal as exhaustive infrastructure logging.

## Per-player metrics

All board snapshot averages use the board **after its own successful move and spawn**. They exclude the initial board and do not count repeated frozen-board snapshots. Human and opponent denominators can therefore differ.

| Metric group | Stored measurements and denominator |
|---|---|
| Score | Final merge score, score gain per move, score per successful move, gain distribution |
| Merges | Total merges, merged-value histogram, destinations, moves without merges, longest no-merge streak, fraction of moves containing at least one merge |
| Progress | Maximum tile, first recorded move/round/score reaching each power-of-two milestone from 8 upward, terminal board status |
| Space | Empty-cell and legal-direction distributions after each move; mean/min/max and percentiles |
| Structure | Monotonicity, normalized occupied-neighbor roughness, tile-value entropy; distributions over active snapshots |
| Anchoring | Fraction of active snapshots with a maximum tile in any corner; maximum-tile position counts |
| Behavior | Four-direction frequencies, 4×4 consecutive-action transition matrix, reversals and reversal rate over `moves - 1` opportunities |
| Heatmaps | Occupancy fraction by cell, mean tile value including zero-valued empty snapshots, merge destinations, spawn destinations, maximum-tile positions |
| Spawn values | Counts of 2 and 4 spawns; initialization is excluded |
| Heuristic comparison | Compared moves, agreement with deterministic best baseline candidate, nonnegative baseline-utility gap distribution |

Heuristic comparison is **not** optimal-play regret or evidence that a human/JEV decision was incorrect. Human candidates use the documented cheap Easy proxy, while opponent candidates can have deeper search. Those proxy gaps are not directly interchangeable across actors or difficulty cohorts.

Tile entropy is Shannon entropy of the occupied exponent-frequency distribution, in bits. It is a descriptive board feature, not uncertainty about the true game state.

## Candidate and model measurements

One row per legal root candidate includes action/name, selected flag, afterstate in the event, merge gain, empty cells, legal directions, largest tile/corner status, adjacent equal pairs, monotonicity, roughness, tile entropy, exact immediate spawn-block probability, expected legal moves, deterministic baseline utility, model utility where available, and the bounded-search summary.

Search summaries include requested depth, greatest reached depth, assigned node budget, admitted state count, frontier evaluation count, value, and whether deeper expansion was truncated. Frontier evaluations preserve probability mass and can cause actual work beyond the admitted-node counter. All root moves are retained and each receives the same floor-divided share of the configured budget. Subtree traversal is deterministic, not unbiased sampling of every possible continuation.

For every JEV candidate/dimension, retain the raw five-level rubric score, probability of each level, rubric legend, and provider confidence. Derived metrics include:

- Weighted policy utility and the selected-versus-runner-up utility margin.
- Weighted selected-candidate confidence; distribution of individual-question confidence.
- Entropy of each rubric answer distribution, in bits.
- Agreement/disagreement with the separately calculated baseline candidate.
- Candidate counts, admitted search states, truncated candidate count.

Confidence is the provider's rubric certainty, not probability of winning or a calibration guarantee. The interface contains structured decision evidence only; it does not claim access to hidden model thoughts.

## Timing and availability

Latency summaries use finite observed values and linear-interpolation quantiles: min, max, mean, p50, p90, p95, p99, plus count. An empty sample returns `null`, not zero.

`decisionLatencyMs` includes recorded local/forced/model decisions; use the `sources` map or exported rows to isolate native model calls. `providerLatencyMs` summarizes recorded HTTP responses and includes failed status codes with a response. Failures without an HTTP response retain their own event latency but are not misrepresented as successful response latency.

`featureLatencyMs` measures candidate preparation. `performance.roundServerMs` is the recorded round computation interval before the final transaction; it is **not** a full browser round trip or transaction durability latency. `analyticsOverheadMs` measures human candidate comparison preparation. `observedWallMs` spans the first through last recorded event and includes user pauses; it is not CPU time.

Request count, retry count, failure events, failed HTTP statuses, invalid-response events, and resumed rounds are separate. A temporary HTTP failure followed by success is not equivalent to an abandoned duel. Source counts distinguish `jev`, `forced`, `heuristic`, `finished`, and explicitly benchmark-only `scripted` decisions.

## Usage and cost

Retain provider-returned usage on every response, including failed attempts if supplied. Summaries report known input/output token totals independently, attempts with both counts, attempts missing either count or a response, and per-field known-attempt counts.

For example, a response with 100 input tokens but no output count contributes 100 known input tokens and an incomplete usage attempt. A timeout does not imply zero billable usage. `complete` describes reported coverage, not correctness of provider billing.

`estimatedCostUSD` is deliberately `null`: no dated tariff or billing account was configured. This version does not fetch prices or reconcile invoices. Offline consumers may apply an explicit tariff to known usage, labeling incomplete totals as lower-information estimates rather than exact costs.

## Optional browser telemetry

Default: **off**. Opt-in events are separate from authoritative hash-chained gameplay evidence and have `trust: untrusted-opt-in`:

- Input event with claimed think duration and input metadata allowed by the server.
- Network round-trip timing.
- Frame gap measurements and page visibility.

The server accepts only enumerated event types and bounded numeric/boolean fields. It does not collect text input, browsing history, precise location, audio, or a device fingerprint. Failed telemetry never blocks a move. It cannot establish whether a person used an external solver. Turning it off stops future collection; erasing historical records is an operator/account-maintenance action.

## Export tables

`npm run export -- audit.json directory` verifies first, then writes:

| File pair | Row granularity |
|---|---|
| `moves.csv`, `moves.jsonl` | One actor's successful move; score/structure/spawn/source, event sequence/hash |
| `candidates.csv`, `candidates.jsonl` | One opponent root candidate for a committed round |
| `cells.csv`, `cells.jsonl` | One cell of one actor after its successful move; 16 rows per active-board move |
| `answers.csv`, `answers.jsonl` | One response/question/rubric level, with probability, score, confidence, legend |
| `requests.csv`, `requests.jsonl` | One recorded HTTP response; status/latency/model/usage/request linkage |
| `telemetry.csv`, `telemetry.jsonl` | One explicitly untrusted client event |

Also writes `events.jsonl`, `manifest.json`, `analytics.json`, and `verification.json`. For attempts with no response, consult `jev_requested` and `jev_failed` in the full journal; they are not fabricated HTTP response rows. Candidate feature-only events from failed rounds remain in the journal even though there is no committed candidate-table row.

CSV preserves numeric negative values while neutralizing formula-like untrusted strings. JSONL retains types and nested structures. The optional Parquet converter requires PyArrow and skips truly empty tables instead of inventing schema/data. SQL/DuckDB/pandas users can ingest the exported files independently of the game.

## Completeness and operational limits

The authoritative decision evidence is not sampled. Plotted points are bounded for responsive presentation; exports retain every recorded point. The UI's expandable raw decision and source labels remain inspectable.

Full analytics currently materialize the selected bundle in memory. Large browser imports can be slow and are rejected above 128 MB. Audit downloads and verification are paged/streamed on the server, but browser parsing and offline CSV/JSONL generation are not streaming reducers. For long or highly instrumented traces, use a sufficiently provisioned Node host and the offline tools. Do not equate the 128 MB import limit with a guarantee of 128 MB browser or Worker memory consumption.

Not measured in this release: provider GPU/server internals, true model calibration, browser memory across devices, definitive cheating detection, bill reconciliation, advertising analytics, user acquisition funnels, or physiological “thinking time.” These would require different evidence and/or consent.
