---
"@mcpjam/cli": minor
---

**BREAKING BEHAVIOR:** `mcpjam cloud eval run --wait` now exits with a six-code
verdict-based contract instead of its legacy two-outcome one. Default (no
`--wait`) behavior is byte-identical — this only changes `--wait`, which
shipped 2026-08-23, so the compatibility window was days old. This is a
direct flip with no opt-in flag; `eval gate` is untouched and keeps its
existing four codes (`0`/`1`/`2`/`3`, where `3` = incomplete/non-gateable) as
a deliberate v1 compatibility exception.

Every flip, named explicitly:

- **A completed run whose verdict FAILED now exits `1`** (was `0`). Read
  `passed` in the report, or use `eval gate` — those still work — but a
  script relying on `--wait`'s own exit code to detect a failed run gets one
  now, for the first time.
- **A wait that hit its deadline with the run still non-terminal now exits
  `5`** (was `1`) — "no valid verdict observed," not a launch/completion
  failure.
- **A partial or wholly failed fan-out now exits `4`** (was `1`) — a setup
  defect the CLI itself observed, kept out of the verdict-failure code `1`.
- **A missing credential, or an `UNAUTHORIZED`/`FORBIDDEN`/`OAUTH_REQUIRED`
  launch or mid-wait failure, now exits `3`** (was `1`) — auth failures are
  isolated so a pipeline can retry after fixing the credential without
  guessing whether `1` meant "bad creds" or "the evals regressed."
- A run whose own `status` is `cancelled`/`timed_out`/`failed` (an execution
  state, not a verdict), an `inconclusive` result, or a `null`/unrecognized
  result all exit `5`.
- A multi-target launch merges these worst-of across every waited run, in
  the fixed order `1 > 3 > 4 > 5 > 0`: a real verdict failure is never
  masked by a sibling's infrastructure noise, and a credential failure
  outranks a plain connection failure.
- A local `--out` report-write failure now exits `4` instead of the generic
  `INTERNAL_ERROR` default of `1`.

No infrastructure condition maps to `1` — that code is reserved exclusively
for a run the platform actually graded as failed. New module:
`cli/src/lib/eval-run-exit-code.ts` (`evalRunWaitExitCode`,
`classifyLaunchErrorExitCode`, `classifyWaitErrorExitCode`), a pure sibling of
the existing `eval-gate-exit-code.ts`. `docs/cli/reference.mdx` and
`docs/cli/ci.mdx` document both contracts and cross-link the deliberate
`eval gate` exception so the two never drift into undocumented divergence.
