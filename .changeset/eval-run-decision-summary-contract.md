---
"@mcpjam/inspector": major
"@mcpjam/sdk": major
"@mcpjam/cli": major
---

One canonical eval run decision summary, shared by the API, Platform MCP and the CLI

The six-stage user-value chain was eval metadata that each client interpreted for
itself: the API returned stage rows, the CLI counted iterations and produced its
own verdict, the Platform MCP server returned neither, and a model had to
reconstruct the chain from raw tool calls. Three readings of one run is three
chances to disagree about it.

There is now one versioned contract — `evalRunDecisionSummarySchema` /
`EvalRunDecisionSummary` in `@mcpjam/sdk/contract`, schema version 1 — assembled
by a single function that the new API endpoint and every client call:

- `GET /v1/projects/{projectId}/eval-runs/{runId}/decision-summary` returns it,
  with bounded diagnostic pagination. Additive: every existing run and iteration
  response field is unchanged.
- `get_eval_run` returns it on `decisionSummary` for terminal runs and tells the
  model to read it before step results or a trace.
- `eval run --wait`, `eval status`, `eval gate` and `eval compare` render it, and
  human, JSON, JUnit and HTML now agree on the verdict, the counts and their
  unit, the first failed stage, the failure category, the evidence and the next
  action. JUnit carries it as `<system-out>` rather than dropping the chain.

What the contract fixes, beyond having one of them:

- **Counts say what they count.** `measurementUnit` is `caseVariant` under
  verdict policy v2 and `trial` on a legacy run. A 3-case suite with 5
  repetitions is legitimately 3 or 15, and the previous summary called both
  "cases".
- **The verdict is copied, never recomputed.** Under policy v2 the run's own
  `EvalVerdictDecision` is the authority; the per-trial diagnostics are evidence
  beneath it. The old summary derived a verdict by counting iterations, which
  reported a case that passed 4 of 5 trials as one pass and one failure.
- **`notEstablished` is a fourth verdict**, for a run that is unfinished, stopped
  early, or whose decision could not be read — distinct from `inconclusive`,
  which is a decision the validity phase reached.
- **Evidence belongs to the claim it supports.** Span ids, prompt indexes and
  reasons come from the first failed stage's row alone; the old summary unioned
  them across the whole chain, handing back the evidence of every stage that
  worked as the explanation of the one that did not.
- **A partial page says so.** `diagnostics.complete` and `scannedIterations`
  separate "nothing failed" from "we did not look".
- Stage, state, category and reason labels are centralized beside the contract,
  so human output reads `User value`, not `userValue`.

`PlatformEvalIteration` gains an optional `caseId` — the case's SDK-declared id
from the iteration's frozen snapshot, beside (never merged into) the stored
`testCaseId`. Omitted, not nulled, when a run recorded none.

Compatibility notes:

- The reporter artifact's `decisionSummary` field now carries the canonical
  object. It previously held an unversioned per-case summary; a consumer reading
  `decisionSummary.passRate.percent` and `decisionSummary.cases[]` should read
  `counts` (with its `measurementUnit`) and `diagnostics.items[]` instead. The
  object now carries its own `schemaVersion`.
- `eval status` prints the block for any terminal run that did not pass, rather
  than only a failed one — `inconclusive` and undecided runs are the ones a
  reader can least explain unaided — and prints it above the `View:` line.
- `buildEvalDecisionSummary`, `buildEvalDecisionSummaryFromIterations` and
  `formatEvalDecisionSummary` are unchanged and still exported, now deprecated.
  Nothing in this repo calls them.
- Exit codes are untouched, including `eval gate`'s four-code contract.

Deployment order matters: the endpoint must be live before the new SDK and CLI
are published. The published clients fall back to the same shared assembler over
`getEvalRun` + `listEvalRunIterations` when the endpoint is absent, so an older
or custom API deployment still gets the same object rather than a second
opinion about the run.
