---
name: user-value-chain-glossary
description: Defines every member of MCPJam's user-value chain vocabulary — the six stages, the five stage states, the twenty-nine stage reasons, the seven failure categories, the four verdicts and the stage-analytics exclusion classes — plus the population rules that decide what a count means. Use when reading a `decisionSummary`, a stage chain, or stage analytics returned by MCPJam's eval tools and you need to know what a wire value means or whether a number can be compared.
---

# The user-value chain, member by member

MCPJam's eval results travel as WIRE ENUMS: `userValue`, `argumentMismatch`,
`evaluatorErrorRateAboveMaximum`. That is correct on the wire and useless
without definitions, and the meanings are not derivable from the spellings.
This is the definition of every member.

**The story these values tell, in order:** what was decided → how much was
measured → where the chain broke → the evidence supporting that → who should
look next. The decision summary says what the eval decided. The user-value
chain explains how far value travelled, where it stopped, what evidence
supports that claim, and who should investigate next.

**Source of truth.** Every word below is copied from
`sdk/src/contract/decision-labels.ts` (the label maps),
`sdk/src/contract/chain.ts` (stages, states, categories),
`sdk/src/contract/stage-derivation.ts` (`STAGE_REASONS`) and
`sdk/src/contract/stage-analytics.ts` (exclusion classes, parity). A test in
`mcp/tests/` asserts this file names every member of
`DECISION_LABEL_VOCABULARIES` and quotes each label verbatim, so drift here
fails the build rather than misinforming you.

## The one rule that matters most

**A first failed stage is a LOCATION. A failure category is a BUCKET. Neither
is a cause, and neither on its own authorizes proposing a change to the server
under test.** The nearest thing to a cause is the `reason` on that stage's own
row — and even that says what was observed, not what to fix.

## The six stages

They run in this order, and **the order is normative**: `notReached` is derived
from position — but only over a stage that decided nothing of its own. A stage
AFTER the first failure that has its own evidence keeps its measured verdict;
the derivation overwrites only the rows that were otherwise `notMeasured`. A
case whose `selection` failed on a stray call still made the expected call and
still ran its predicates, and those rows say so.

`connection` → `discovery` → `selection` → `call` → `response` → `userValue`

| Wire value | Words | The question it answers | What good looks like |
| --- | --- | --- | --- |
| `connection` | Connection | Could the client reach the server and initialize a session? | Session connected |
| `discovery` | Discovery | Did the client receive usable primitives and metadata? | Tools and resources discovered |
| `selection` | Selection | Did the model choose the right tool for the request? | Right tool selected |
| `call` | Tool call | Was the call made with usable arguments? | Valid call made |
| `response` | Response | Did the server return data the model could use? | Usable response returned |
| `userValue` | User value | Was the user's actual request satisfied? | Request satisfied |

## The five stage states

The three non-verdicts are three different facts. Collapsing them is how "we
never checked" gets read as "it passed".

| Wire value | Words | What it means |
| --- | --- | --- |
| `passed` | passed | Measured, and the link held. |
| `failed` | failed | Measured, and the link did not hold. |
| `notReached` | never ran (an earlier stage failed) | Position, applied only to a stage that decided nothing of its own: the chain broke upstream and that is why nothing is known here. Not a verdict about this stage — and not applied to a later stage that WAS measured, whose own rows survive. |
| `notMeasured` | not measured | The stage was reached and this run captured nothing that could decide it. **Not a pass.** |
| `notApplicable` | not applicable to this case | The authored case asserts nothing this stage could decide. **Not a pass.** |

## The twenty-nine stage reasons

Each completes the sentence "…because <reason>". A CLOSED vocabulary: render
what arrives, never widen it.

**Nothing could be measured**

| Wire value | …because |
| --- | --- |
| `noSpanChannel` | this run captures no evidence channel for that stage |
| `noEvidenceCaptured` | nothing eligible for that stage was captured |
| `matchVerdictUnavailable` | extra tool calls were captured but the run did not report whether its match options tolerate them |
| `traceAbsent` | the iteration recorded no trace |
| `executorEmitsNoSpans` | the executor emitted no spans |
| `blockedByPolicy` | a policy blocked the run before it could be measured |
| `evaluatorError` | the evaluator itself failed, so the run says nothing about the server |
| `providerError` | the model provider failed the call, so this stage was never measured |
| `setupAborted` | the environment was never prepared, so the test never began |
| `connectFailed` | the configured server was reached and initialize failed there |
| `toolsListFailed` | initialize succeeded and listing tools failed |
| `egressUnverified` | the connection failed with no evidence that our own network egress works |
| `lifecycleStopped` | the run was stopped mid-flight |

**The stage does not apply**

| Wire value | …because |
| --- | --- |
| `notAuthored` | the case asserts nothing this stage could decide |

**Position**

| Wire value | …because |
| --- | --- |
| `earlierStageFailed` | an earlier stage failed |

**Measured failures**

| Wire value | …because |
| --- | --- |
| `missingToolCall` | an expected tool call was never made |
| `unexpectedToolCall` | a tool call was made that the case did not expect |
| `argumentMismatch` | the call arguments did not match what the case expects |
| `toolError` | the server reported a tool error |
| `protocolError` | the call never produced a result |
| `renderFailed` | the widget did not render |
| `predicateFailed` | a check on the result did not hold |

**Measured passes**

| Wire value | …because |
| --- | --- |
| `observed` | the evidence was inspected and the stage held |
| `impliedByLaterEvidence` | a later stage's success implies it |

**Advisory LLM judge**

| Wire value | …because |
| --- | --- |
| `judgeObserved` | the LLM judge scored at or above the threshold |
| `judgePartial` | the LLM judge scored inside the partial band — at or above the floor, below the threshold |
| `judgeFailed` | the LLM judge scored below the partial floor |
| `judgePending` | an LLM judge verdict is owed and has not arrived |
| `judgeNotRequested` | no LLM judge verdict was ever owed |

## The seven failure categories

The coarse bucket a non-passing trial is grouped under. `evaluator` is never
folded into the others: a broken judge is not a server defect, and counting it
as one poisons every rate derived from it.

| Wire value | Words | What it groups | The next owner |
| --- | --- | --- | --- |
| `setup` | setup | The harness or environment never got to the test. | check the server connection and environment configuration |
| `metadata` | tool metadata | Tool names, descriptions or schemas misled the model. | review the tool metadata and descriptions in the server catalog |
| `selection` | tool selection | The model picked the wrong tool, or none. | review tool selection and the tool catalog |
| `arguments` | call arguments | The right tool, called wrongly. | review the authored arguments against the tool input schema |
| `serverData` | server data | The server answered, with data the model could not use. | inspect the tool response returned by the server |
| `userValue` | user value | Everything mechanical worked and the user still was not served. | review whether the response answered the user's goal |
| `evaluator` | evaluator | The grader itself failed, so the run says nothing about the server. | check the evaluator configuration; the case was not graded |

## The four verdicts

| Wire value | Words | What it means |
| --- | --- | --- |
| `passed` | passed | The run decided, and it passed. |
| `failed` | failed | The run decided, and it failed. |
| `inconclusive` | inconclusive | The validity phase RAN and withheld a verdict: the run did not measure the server well enough to judge it. A decision, not a defect. |
| `notEstablished` | no verdict established | No verdict exists at all — unfinished, stopped early, or unreadable. `undecided.reason` says which. **Never report it as a regression.** |

### Why no verdict was established

| Wire value | Why no verdict was established |
| --- | --- |
| `runNotTerminal` | the run has not finished yet |
| `runStatusNotAVerdict` | the run stopped before it finished, so its recorded counts describe a sample rather than the run |
| `runResultNotAVerdict` | the run finished without recording a verdict |
| `verdictSummaryUnavailable` | the run was decided under verdict policy v2 and its decision could not be read |

### What the validity phase found

These are the audit trail an `inconclusive` run is explained by.

| Wire value | What the validity phase found |
| --- | --- |
| `configuredTrialsNotAttempted` | some configured trial never ran, so the run does not cover what it was asked to |
| `noGradeableTrials` | nothing in the run produced a gradeable verdict |
| `eligibleTrialsBelowMinimum` | fewer gradeable trials than the suite's validity floor requires |
| `completionRateBelowMinimum` | too few attempted trials completed to meet the suite's completion floor |
| `completionRateNotMeasured` | nothing was attempted, so the completion floor cannot be satisfied |
| `evaluatorErrorRateAboveMaximum` | the evaluator failed too often for this run to describe the server |
| `evaluatorErrorRateNotMeasured` | nothing was attempted, so the evaluator-error ceiling cannot be satisfied |
| `caseHasNoEligibleTrials` | a case graded nothing at all |
| `casePassRateMetThreshold` | the case met its pass threshold |
| `casePassRateBelowThreshold` | a case did not meet its pass threshold |
| `allMeasuredCasesMetThreshold` | every measured case met its threshold |

## Two derivations, two jobs

One run carries **two** derived documents, and they answer different questions.
Do not use one to check the other.

- **The decision summary decides.** Verdict, counts, the population those
  counts are in, and per-trial diagnostics. Under verdict policy v2 the run's
  own `decision` is the authority; the diagnostics sit *underneath* it as
  evidence. A case can pass with a failing trial in it, so tallying the
  diagnostics gives a different answer than the platform reached.
- **Stage analytics explains.** One materialized funnel per run: how many
  trials reached each stage, how many were measured there, and how many were
  excluded and why. It never re-decides the verdict.

## Population rules

Getting these wrong produces numbers that look authoritative and mean nothing.

1. **Read `measurementUnit` before quoting any count.** Under verdict policy
   v2 the counts are `caseVariant` — one case under one provider/model
   execution variant, with repetitions as TRIALS inside it. On a legacy run
   they are `trial`. A 3-case suite with 5 repetitions is legitimately "3"
   under one unit and "15" under the other, so a count quoted without its unit
   is not a fact.
2. **A zero denominator is NOT MEASURED, never `0`.** Stage analytics stores
   counts and derives rates; `0/0` rendered as `0%` reads as "everything
   failed" and as `100%` reads as "all green", and neither was observed.
3. **`notEstablished` is not a failure and not `inconclusive`.** No verdict
   exists at all. `inconclusive` IS a decision the validity phase reached.
4. **`notMeasured` and `notApplicable` are not passes.** Neither is
   `notReached`.
5. **A diagnostics page says whether it is the whole story.**
   `diagnostics.complete` is true only when the listed trials are the run's
   entire non-passing set, and `scannedIterations` says how many were examined
   — so an empty list from a complete page ("nothing failed") is
   distinguishable from an empty list from a partial one ("we did not look").
   Pass the cursor to continue; never present one page as the run's failures.
6. **Never sum stage tallies across stages.** One trial is counted in every
   stage's tally, so adding the six together counts the same trial six times.
7. **Never sum or merge analytics across runs.** Each document describes one
   run's population. A listing is a trend series rendered side by side, never
   an aggregate.

## Why a trial left a denominator

Every exclusion is counted and returned: a denominator that quietly shrank is
indistinguishable from a server that quietly improved.

| Wire value | What it removed from the denominator |
| --- | --- |
| `lifecycle` | The trial never produced a comparable observation: not terminal, skipped, cancelled, timed out, setup-failed, execution-failed, or the evaluator errored. |
| `integrity` | A chain or a measurement was missing, unverified, or rejected at the write boundary. **This is a bug report, not a data property** — a run with a non-zero `integrity` count is telling you something upstream is producing derivations that do not validate. |
| `version` | Produced by an analyzer or schema version this reader does not understand. Never coerced: a version-ahead payload may mean something different by the same word. |
| `notApplicable` | The stage does not apply to this case at all. |
| `reachUnknown` | Nothing was captured, so reach could not be decided. **Excluded from the reach denominator rather than counted as a drop-off** — a trial we captured nothing for is not evidence that value stopped there. |
| `notMeasured` | The stage was reached and nothing decided it. |

## Whether two funnels may be compared

Two rows drawn side by side ARE a comparison claim. `stageAnalyticsParityBlockers`
returns the reasons that claim cannot be made; an empty result means "these
measured comparable things", not "nothing I checked differed".

Partition on these before claiming any trend: `runGroupId`, `configRevision`,
`caseSetFingerprint`, `stageAnalyzerVersion`, `measurementsSchemaVersion`, and
`materializationState: "final"`.

**An ABSENT identity BLOCKS comparability — it is never assumed compatible.**
Two runs that both record no run group compare equal under `a === b` while
sharing nothing at all, which is why `missingRunGroup`, `missingConfigIdentity`
and `missingCaseSetIdentity` are blockers in their own right, distinct from the
`different*` ones.

A `provisional` row is still moving: a judge second pass can rewrite stage
attribution after the run first became terminal, so the row is rebuilt after
each applicable fanout and only `final` means the counts have stopped changing.

## Absence

**There is no backfill.** A run that terminalized before stage measurement
shipped has no analytics row, and it never will. A missing row renders as
UNMEASURED — never as zero, and never as a funnel of empty stages.

Three absences are three different facts, and none may impersonate another:

- **The run does not exist**, or is not visible to this caller.
- **The run exists and has no analytics document.** Honestly "unmeasured", and
  only after the run itself has been retrieved.
- **The deployment does not serve the route.** A fact about the deployment,
  never about the run. Rendering it as "never measured" is a dark-ship failure:
  it reports every run on that deployment as unmeasured.
