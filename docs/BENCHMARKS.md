# Benchmarks and independent evaluation

The benchmark uses the exact production rules, seed derivation, candidate evaluation, and JEV adapter. It is independent of the browser UI.

## Executed sample

`examples/baseline-smoke/report.json` and `runs.csv` contain nine actual measured runs: three development seeds × random/greedy/heuristic opponents, compared with a greedy scripted player, each capped at 64 successful moves. Every run includes a manifest, fsynced event journal, full audit bundle and derived analytics. Each replay was verified.

This is a smoke experiment demonstrating the harness, not a sample size sufficient for a general gameplay-quality conclusion. It contains **zero live JEV requests**. Measured timings apply to the build sandbox, not your server or the TypeSafe service. The cap censors marathon performance.

`examples/mock-provider` is a different evidence class: a synthetic four-round contract example, not an experiment. Its fixture probabilities, confidence, usage and request latency must never be pooled with genuine model measurements.

## Run scripted comparisons

```sh
npm run bench -- --seeds 20 --moves 2048 --policies random,greedy,heuristic,expectimax --baseline greedy --split development --out bench/results/dev-001
```

Use a new output directory per experiment. The runner refuses to overwrite an existing experiment manifest or append into an existing run journal. Stop/restart does not silently resume or pool a prior experiment; retain partial results and start a separately identified run.

Supported policies: `random`, `greedy`, `heuristic`, `expectimax`, `jev:easy`, `jev:normal`, `jev:hard`, `jev:jev`. The default experiment has five seeds, 128 moves, one replicate, and no provider calls.

The `heuristic` benchmark maximizes its explicit baseline utility. It is not the same ordering as the UI's deterministic safety/fallback opponent. Both are documented and recorded; do not conflate their quality measurements.

## Live model experiment

Configure your private API key first. An explicit `--live` flag is required:

```sh
npm run bench -- --live --seeds 100 --moves 2048 --replicates 1 --policies expectimax,jev:normal,jev:hard --baseline greedy --split development --out bench/results/live-dev-001
```

Then freeze parameters and use a separately named held-out split:

```sh
npm run bench -- --live --seeds 500 --moves 2048 --policies expectimax,jev:normal,jev:hard --baseline greedy --split heldout --out bench/results/live-heldout-001
```

These commands can incur real model usage and long runtimes; they were **not executed** in this package. Run a small live contract/cost check before a large experiment. The benchmark is a trusted local tool and does not inherit the hosted app's per-session/global quotas. It processes runs sequentially and keeps durable evidence; it does not promise an asynchronous managed research job.

Use `--seed NAME` to define the reproducible seed family. Initialization/spawn seeds depend on base seed, split and seed index, not policy. Replicates share spawn seeds by design; random baseline choices use an independently seeded decision RNG. The paired scripted-player baseline receives the same spawn stream but acts on its own board.

## Outputs and metrics

Each run writes events.jsonl (fsynced after emission), audit.json and analytics.json. The experiment writes experiment.json, runs.csv and report.json. The rows include policy/baseline, split, seed/replicate, complete/failure status, scores and paired difference, largest tile, move/cap status, recorded provider calls/usage coverage, latency summaries, wall time and verified-chain status.

The summary reports completed/failed counts, mean/median score, reaching-2048 rate, cap-hit rate, and mean paired difference. Descriptive 95% bootstrap intervals use 2,000 resamples of **seed-level replicate means**, not individual turns. At least two independent seeds are required to emit an interval. Bootstrap implementation and RNG are fixed for reproducibility.

Failed runs remain in the report, with their evidence and failure event. They are excluded from completed-score aggregates and must be discussed, not hidden. Infrastructure failure is not an automatic model loss. Replicate coverage may differ after failures; inspect the raw rows and seed counts before interpreting an interval. No automatic multiplicity correction or confirmatory hypothesis test is performed.

## Evaluation design

Separate development, held-out and calibration seed namespaces. Do not tune and report on the same held-out seeds. Compare identical move caps, rule/RNG versions, model pins, input rubrics and search budgets. Retain all candidate sets and provider attempts, including invalid responses and retries.

The important ablation is the same deterministic features/search without JEV versus JEV-assisted candidate ranking. Additional ablations can remove one rubric dimension or change depth while versioning the policy. Repeat identical requests over a calibration subset to quantify response variability; replay itself never reruns a model.

No claim that JEV beats the baselines, that a profile is strongest, or that its confidence is calibrated is supported by the bundled smoke results. Those questions require the live experiment above or an equivalent independently measured study.
