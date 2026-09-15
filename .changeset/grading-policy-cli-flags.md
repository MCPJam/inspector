---
"@mcpjam/cli": minor
---

`mcpjam cloud eval update` gains `--pass-threshold` and `--iterations`, and refuses the pairs that mean two different things.

A suite has ONE pass criterion and ONE iteration rule, and until now the CLI could only write the suite-wide pair. `--pass-threshold <0-1>` writes `settings.passThreshold`, the per-case criterion; `--iterations <n>` writes `settings.repetitions`, the per-case default count. `mcpjam cloud eval get` reports which pair a suite takes under `settings.policy`.

**Passing both flags of a pair is a usage error, not a precedence rule.** `--min-accuracy` and `--pass-threshold` are different criteria rather than two units of one number: ten cases, nine always passing and one always failing, passes a 90% suite-wide bar and fails a 0.9 per-case one. `--min-iterations` and `--iterations` differ the same way — the first RAISES a case's own count and the second REPLACES it, so a case configured for 7 runs 7 times under a floor of 3 and 3 times under a default of 3. A precedence rule here would be invisible: a script that passes both because somebody half-finished a migration keeps running, and the suite it edits is decided by whichever of two different bars the CLI happened to prefer, with the other flag reported as accepted.

`--pass-threshold 90` is refused before any request with a message naming the units. It would otherwise reach the wire as a 9000% per-case bar, and the route's refusal would name a field the caller spelled correctly.

The decision-summary line the CLI prints now names the criterion rather than the policy version: `Decision summary: failed (suite accuracy threshold) — 0/1 iteration passed` where it read `(legacy percent-threshold run)`.
