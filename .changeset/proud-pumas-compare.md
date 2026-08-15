---
"@mcpjam/sdk": minor
"@mcpjam/cli": minor
---

Add run-over-run comparison and comparative gates.

`compareEvalRun` on the platform client fetches
`GET /projects/{p}/eval-runs/{runId}/compare`: per-case status (regressed,
fixed, new, removed, changed), per-scorer pass-rate and mean deltas from the
evaluation contract, and whether the evaluation config changed. Omitting
`baseRunId` compares against the nearest earlier completed run in the same
suite; a run with no comparable predecessor throws a `PlatformApiError` with
`details.reason: "BASELINE_NOT_FOUND"`, which is an incomplete comparison
rather than a failing one.

New `compare-stats` module: Wilson score intervals and Newcombe's
hybrid-score interval for the difference between two pass rates, plus
`assessPassRateRegression`. "The pass rate dropped 4 points" is not evidence
of a regression at 10 iterations, so the verdict has three states —
`insufficient_data` is not `no_regression`. The interval bounds are pinned
against statsmodels, not against a second reading of the implementation.
`detectFlakyCases` reports within-run instability, which is never gated.

`GatePolicy` gains three comparative fields — `noDeterministicRegressions`,
`maximumP95LatencyIncreaseMs` and `passRateRegression` — evaluated by the new
`evaluateCompareGates`. Passing any of them to the single-run `evaluateGates`
is now a usage error rather than a silent no-op. The statistical and latency
gates are non-gateable unless the two runs cover the same population: same
case set, same scenario configs, same evaluation config, and equal per-case
iteration weighting. Deterministic per-case regressions still gate under a
population change, since they join by case key.

New `mcpjam eval compare` applies that policy to a hosted run and sets an
exit code (0 pass, 1 regression, 2 usage, 3 incomplete), with
`--reporter json-summary|junit-xml` and `--out` via the same structured
report the server-diff reporter uses. It has no `--wait`: comparing against
an unfinished run compares against a partial population.

Also exported: `calculateLatencyStats` / `calculatePercentile` from the main
entry, already used internally by the gate engine.
