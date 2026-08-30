---
"@mcpjam/sdk": patch
"@mcpjam/inspector": patch
---

A judge case carries the iteration it graded

`judges.goalCompletion.cases[]` and `judges.groundedness.cases[]` projected only `caseKey` — a random `ui_*` storage key that matches nothing any other route returns. Not the `id` or `declaredId` from the case routes, not the iteration ids from `eval iterations`. The field's own documentation says so, and correctly warns callers off joining it against case ids.

Which left **array position** as the only way to pair a judge score with the iteration it graded: assume the judge's ordering matches the iterations' ordering and hope. Nothing in the contract guarantees that, and being wrong attributes a score to the wrong case without any signal that it happened.

The join key was already persisted — `saveGoalCompletion` patches each iteration through the case's `iterationId`. This exposes it rather than inventing one, on both judges and on `PlatformEvalRunJudgeCase`.

`iterationId` is **optional**: judge results written before it was persisted carry none, and a caller must be able to tell "this run predates the join key" from a value it can act on.
