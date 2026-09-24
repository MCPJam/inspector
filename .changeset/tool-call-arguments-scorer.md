---
"@mcpjam/inspector": minor
"@mcpjam/sdk": minor
---

Split the argument check out of the expected-tool-calls score. A hosted case that expects tool calls is now graded by two scorers:

- `toolCalls:match` (version 3) now covers **selection only**: every expected tool was called, and no turn made more extra calls than `maxExtraToolCalls` allows. A right tool called with a wrong argument no longer fails it.
- `toolCalls:arguments` (new, at the Tool call stage) checks that the expected tools were called with the expected arguments. Its reason names the tool and the argument, never the value. It is declared only when the case compares arguments (`argumentMatching` is not `"ignore"`).

Both scorers are required. Together they pass exactly when the old single score did, so an existing gate on `toolCalls:match` keeps its meaning in aggregate. The scorecard shows an **Arguments match** row under Tool call. Runs graded before this change show no such row and render as before.

**Re-baseline after upgrading.** The set of score definitions changed, so `evaluationConfigHash` changed with it. The first run after this release cannot be gated against a `--baseline` from before it: `eval gate --baseline <older run>` exits 3 (not gateable). Record a new baseline from a run on this version.

`EVALUATOR_STAGE` (and `GRADER_STAGE`) in `@mcpjam/sdk/contract` now files `toolCalls:arguments` at `call`.
