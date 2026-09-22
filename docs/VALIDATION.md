# Validation record

Build environment: Node.js 22.16.0; native SQLite; Python 3 with Playwright; locally available Chromium. External service credentials were not supplied.

## Executed checks

| Check | Observed result |
|---|---|
| Node unit/integration/security/analytics suite | 35 tests passed; zero failures or skips |
| Exhaustive short-line rule enumeration | 1,296 lines × 4 directions = 5,184 directional cases, plus explicit merge fixtures |
| Rule properties | Mass preservation during movement, score arithmetic, no double merge, immutable inputs, valid spawning, terminal and move-cap behavior |
| RNG and cryptography | Deterministic spawn vectors, equal initialization, probability mass, commitment, encryption and signed-token round trips |
| Backend | Actual in-memory SQLite transactions and API handler, ownership, CSRF, bad fields/actions, idempotency, concurrent reservations, pause/downgrade, replay verification |
| Discord contract/security | Mocked OAuth identity exchange plus actual generated Ed25519 signature verification; wrong body/timestamp/user/state and token reuse rejected |
| JEV contract | Mocked typed answers, malformed responses, missing fields, pinned model, transient/permanent failure, no silent substitute, recorded evidence replay |
| Analytics | Known versus missing token usage, null empty distributions, normalized row counts, move/spawn counts, streaming versus array verifier agreement |
| Leaderboard | Verified mocked-provider result publication, unique result, best-per-user query, ties, paging and context isolation |
| Benchmark smoke | Nine completed scripted baseline runs, three seeds, 64 moves per active board; all replays verified; zero live provider requests |
| Synthetic model example | Four-round mock-provider contract bundle verified; offline exports: 8 moves, 16 candidates, 128 cells, 160 rubric-level rows and 4 response rows |
| DOM/API bridge | Actual HTML/CSS/JS with real loopback API; 25 gameplay rounds, controls, analytics, replay, audit checking and scope-empty states; no page errors |
| Responsive checks | 1440px desktop and 390px mobile; no horizontal page overflow; actual screenshots included |

Raw outputs: `test-report.txt`, `coverage.txt`, `browser-test-report.json`. The test coverage report is instrumented Node coverage of imported files; it includes test helpers and **does not establish whole-product browser or deployment coverage**. In particular, unimported runtime entry points and cloud infrastructure are not covered by that percentage.

## Browser-test limitation

Normal browser navigation was blocked by the build environment's managed Chromium policy, and an alternate Playwright browser could not be fetched. That policy was not changed or bypassed. The executed `tests/browser_bridge.py` harness injects the actual static assets into an isolated DOM and bridges fetch calls to the actual loopback server through Python. It uses test-only storage and SHA-256 shims in the isolated origin.

This exercises rendering, DOM event handling, game logic, UI state transitions and real API responses. It does **not** exercise native browser-origin cookies, CORS, CSP, TLS, OAuth redirects, or production network routing. Screenshots are actual rendered application output from that harness, not mockup images. The supplied `tests/browser_smoke.py` is a normal-navigation smoke test to run in a staging environment where normal browser navigation is available.

Reproduce the executed bridge check with the local server running, Python Playwright installed and a local Chromium executable:

```sh
python tests/browser_bridge.py
```

Optional `TEST_ORIGIN` and `CHROMIUM_PATH` environment variables select the local target and browser. Use an instance without a TypeSafe key for this local-practice test. Do not point this development bridge at an untrusted external server.

For a normal browser, install the optional development tools in your environment:

```sh
python -m pip install playwright
python -m playwright install chromium
python tests/browser_smoke.py
```

## Not executed or certified

No live TypeSafe/JEV request, no real Discord consent/account/guild installation, no live Cloudflare/D1 deployment, no container build, no cross-browser matrix, no independent accessibility audit, no production-scale load test, and no independently audited security certification.

The API fixture test named “native JEV fixture evidence” exercises the application's native JEV **adapter path using a mocked provider**, not genuine external inference. Synthetic confidence/usage/latency is never presented as model performance. Provider and cloud integration claims are limited to implemented code and documented-contract/mocked testing.

## Integrity of artifacts

`SOURCE_MANIFEST.json` identifies source inputs and their SHA-256 hashes. `server/build-info.js` embeds the aggregate identity in newly created matches. Examples retain the source identity under which they were generated. `SHA256SUMS.txt` covers the archive files other than itself; use it to detect accidental changes. Neither file is an independently signed release.

To rerun the deterministic tests and rebuild source identity after modifying code:

```sh
npm test
npm run test:coverage
npm run fingerprint
```

Keep modified-policy benchmark output in a new experiment directory. Do not relabel prior traces as if generated by the changed source.

The optional Parquet converter was syntax-checked and its missing-dependency handling was exercised. PyArrow was not installed, so actual Parquet generation was not executed. JSON, JSONL and CSV export were executed successfully.
