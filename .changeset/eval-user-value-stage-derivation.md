---
"@mcpjam/sdk": minor
"@mcpjam/inspector": minor
---

Every eval iteration now reports which stage of the user-value chain it reached.

`@mcpjam/sdk/contract` has pinned the chain vocabulary — `connection`,
`discovery`, `selection`, `call`, `response`, `userValue`, and the five states a
stage can be in — since Wave 0, with nothing deriving it. This adds the
derivation: `deriveStageResults`, a pure, deterministic, versioned function that
turns one iteration's authored case plus whatever it captured into six stage
rows, and persists them on `testIteration.metadata` beside the existing
`stepResults`.

## `deriveStageResults`

```ts
import { deriveStageResults } from "@mcpjam/sdk/contract";

const {
  stageResults,
  firstFailedStage,
  failureCategory,
  stageAnalyzerVersion,
} = deriveStageResults({ authored, evidence, iteration });
```

It takes the **authored case** as well as the evidence, and that is the part
worth knowing before you use it. Without knowing what a case asserts there is no
way to tell "this stage does not apply here" from "this stage was not measured",
and a render probe with no model turn would report a missing `selection` verdict
as a gap somebody is then asked to go and close. Applicability is inferred from
what the case already declares — a case with no `prompt` step has no `selection`
stage, a case that expects no tool call has no `call` or `response` stage.
Nothing new is authored, and no stage can be toggled by hand.

Three rules the function exists to enforce:

- **Missing evidence is never a pass.** A stage reaches `passed` only when
  something eligible was actually inspected; otherwise it is `notMeasured` with
  a reason. A trace carrying messages but no spans — what a caller-supplied
  `HostExecutor` produces, since spans are not part of that interface — is
  reported as `executorEmitsNoSpans`, distinct from "the run did nothing".
- **`notReached` is positional.** Every stage after the first failed one is
  `notReached`, per the normative `USER_VALUE_STAGES` order. The returned rows
  are always all six, in that order; sorting them silently changes which stages
  a failure is reported to have blocked, and `stageDerivationSchema` rejects a
  payload that arrives re-sorted.
- **A broken grader is never a server defect.** An evaluator error makes
  `userValue` `notMeasured` and the category `evaluator` — it is not folded into
  `serverData` or `userValue`, and it does not launder a server failure the
  spans already prove.

A policy block is represented as `notMeasured` plus a policy reason rather than
a failure; enforcing policy is a separate concern. Lifecycle stops
(`setup_failed`, `cancelled`, `timed_out`, `skipped`) and failed rows that
captured nothing at all are reported as `setup`, so harness noise does not
inflate any server failure rate.

`failureCategory: "metadata"` is deliberately never derived. It means tool names
or schemas misled the model, which is a judgement no span carries; deriving it
mechanically would be guessing.

## What lands on an iteration

`metadata.stageResults`, `metadata.firstFailedStage`,
`metadata.failureCategory` and `metadata.stageAnalyzerVersion`, written by both
the hosted/GitHub finalize path and the SDK result mapping. The version is
stamped on every derivation so stored rows can be targeted for recomputation
when the semantics change — a versioned analyzer whose version is not persisted
cannot be selectively rebuilt.

No schema change: `testIteration.metadata` is an open record and both write
paths already carry nested values.

Consumers reading `metadata` should treat these keys as server-derived and the
`notMeasured` states as load-bearing. `notMeasured`, `notApplicable` and
`notReached` are three different reasons there is no verdict; rendering any of
them as a pass is the failure mode this whole contract exists to prevent.
