---
"@mcpjam/sdk": patch
"@mcpjam/inspector": patch
---

A tool-call assertion that fails now files at `selection`, not `userValue`

`stepsToPromptTurns` promotes only `toolCalledWith` into `expectedToolCalls`, where the selection matcher grades it. The other three tool assertions — `toolCalledAtLeastOnce`, `toolNeverCalled`, `firstToolWas` — fall through to per-turn checks and arrive at the analyzer as predicate results, which `deriveUserValue` graded as user value.

So a case asserting "tool `get_project` was never called" reported `userValue: failed / predicateFailed` with `selection: passed`. The chain said the user did not get what they asked for; what actually happened is the model picked the wrong tool. Across one audited prod window that single mis-routing is most of the gap between 2 selection failures and 12 user-value ones — the report card blaming the wrong stage on the failures operators most need to attribute.

The three kinds now route to `selection`, and they do **not** share applicability:

| predicate | failure files as | expects a call? |
|---|---|---|
| `toolCalledAtLeastOnce` | `missingToolCall` | yes |
| `firstToolWas` | `unexpectedToolCall` | yes |
| `toolNeverCalled` | `unexpectedToolCall` | **no** |

`toolNeverCalled` is the asymmetry that makes this a matrix rather than a set: a case whose only tool assertion forbids a call expects none, and turning `call` on for it would demand evidence of the very thing the case exists to rule out.

Passing rows route too, not just failing ones. A case whose only selection assertion is "never call the admin tool", which did not call it, has *measured* selection and found it sound — reporting that as `notMeasured` understates what the run established. And they are **routed, not copied**: a failure filed at both stages would double-count one defect and make `firstFailedStage` depend on which stage a reader looked at first. For the same reason `buildStageAuthoredCase` stops counting them in `assertionCount`, so a `toolNeverCalled`-only case no longer reports a permanent user-value gap that no author could close.

`toolCalledWith` is deliberately untouched: it is already matcher-graded, and re-reading its point-in-time predicate row here would let a raw residual contradict the adjudicated verdict.

Two mechanical notes. The predicate discriminator was always present at runtime — `PredicateResult` carries the whole predicate — and was being erased by a cast in `finalize-iteration`; it now crosses with the row, and a row *without* one grades exactly as before, which is why the analyzer bump to 6 changed no recorded row in the historical-parity corpus. `STAGE_REASONS` does not move (the routing re-uses `missingToolCall` and `unexpectedToolCall`), so the backend mirror needs no re-pin.

Verdicts, gate exit codes and pass/fail counts are unchanged: nothing in `iteration-verdict.ts`, the gate layers or the tallies reads stage rows. This does widen the D7 metadata-attribution judge's candidate population, since it gates on `firstFailedStage === "selection"` — intended, and the reason more selection failures now reach it is that they were always selection failures.
