---
"@mcpjam/cli": minor
---

`eval gate` gains `--baseline <runId>`: gate a run against a regression delta
from an earlier one, not just an absolute threshold.

Passing `--baseline` fetches the same run comparison `eval compare` uses,
evaluates it with the existing comparative gate engine, and folds the result
into the run's threshold `GateReport` with the established outcome precedence
(`usage_error > failed > incomplete > passed`) — one report, one exit code,
verdicts from both families visible. The comparative tuning flags
`eval compare` already has (`--min-sample-size`,
`--min-effect-size-percent`, `--gate-deterministic-regressions`,
`--max-p95-latency-increase-ms`) work here too; `--baseline` itself implies
regression gating, so none of them need a separate enabling flag, and passing
one without `--baseline` is a usage error rather than a silent no-op.

A changed, added, removed, or unequally-weighted case set makes the
WHOLE-RUN pass-rate and p95-latency gates `non_gateable` (exit 3) rather than
silently passing or misreading the population change as a regression — the
same population rule `eval compare` already enforces. The deterministic
per-case regression gate is exempt: it joins by case key, so it can still
fail (exit 1) on a matching case even when the population around it changed,
and a real failure there is never buried by an undecidable whole-run gate. A
missing baseline is the existing `BASELINE_NOT_FOUND` → incomplete → exit 3
path. `eval gate`'s four-code contract is unchanged.

The report (`--reporter`/`--out`) carries baseline provenance — both run
ids, the resolved baseline policy, every compatibility signal that was
evaluated, and the comparable case ids the verdict actually covers. The
policy is recorded with its defaults already resolved (e.g. the
`--min-sample-size`/`--min-effect-size-percent` values the pass-rate
regression gate actually ran with, not just whatever was or wasn't passed
on the command line) — `null` when the corresponding gate wasn't
requested at all, distinct from a threshold of zero — so an archived
report is self-describing without cross-referencing the CLI invocation
that produced it. A case can survive `caseSetChanged` (it exists on both
sides) and still be individually responsible for a config change or
unequal iteration weighting — including a run-level evaluation config
change that the platform didn't also flag on that case's own row — so
each excluded case is named with its own reason (`case_added`,
`case_removed`, `scenario_config_changed`, `evaluation_config_changed`,
`iteration_weighting_unequal`) rather than being silently counted as
comparable. Dimensions the comparison wire does not carry yet
(model/provider, host/harness, server/environment identity, config hashes
beyond the evaluation config hash) are recorded explicitly as
`"notRecorded"` rather than omitted.

SHA baselines are not supported yet — a 40-hex `--baseline` argument is
rejected with a usage error naming the follow-up; only run ids resolve today.
A blank `--baseline` (e.g. an unset CI variable interpolated into the flag)
and a `--baseline` equal to `--run` are both usage errors too, rather than
silently disabling the comparison or comparing a run against itself and
reporting a clean "no regression" that never consulted an independent
baseline. Validation checks the trimmed value, and the trimmed value is what
travels to the request — a whitespace-padded but otherwise valid
`--baseline` cannot slip past validation and then fail to resolve on the
wire.
