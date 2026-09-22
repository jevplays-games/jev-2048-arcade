# Executed baseline smoke experiment

Nine real scripted-baseline runs: three development seeds × random, greedy and heuristic policies. Each runs on its own board, paired against a greedy baseline using the same hidden-spawn protocol, with a 64-successful-move cap.

Every run completed and verified. These runs made **no live JEV requests**. This small, deliberately capped sample validates the experiment/export machinery; it is not evidence of JEV quality or a general baseline ranking.

See report.json for aggregates, runs.csv for measured rows, and each run folder for fsynced events.jsonl, audit.json and analytics.json. See ../../docs/BENCHMARKS.md for methodology and larger live-run commands.
