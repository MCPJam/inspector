---
"@mcpjam/inspector": patch
---

Provider attribution actually reaches the runner — it was cut in three places

Three breaks in the wire between a classified provider failure and an attributed chain. Together the first two meant `providerError` **never fired on the hosted path at all** — the path the audited Anthropic-credit trials ran on.

**The hosted bridge copied only the message.** `buildHostedStepHandlers` converts a `HostedEvalTurnOutcome` into a `StepEngineOutcome`, and both of its sites copied `iterationError` / `iterationErrorDetails` and nothing else. `drive-hosted-eval-turn` classified the failure and `step-executor` was ready to propagate it, but the classification died one hop from where it was made, so `iterationStepError` was never built and no hosted run was ever attributed.

**The widget follow-up loop reduced a full outcome to a bare string.** A turn that dies on the provider is the same event whether it was the prompt or a `ui/message` follow-up; reporting one and not the other made attribution depend on which turn the model happened to fail on.

**The judge second pass re-derived without it.** `stepError` is transient runner state — an input to the first derivation, never persisted — so the moment a judge verdict landed, `providerError` and the `setup` category were silently dropped and the run went back to being filed against the server.

That last one is recovered from the stored chain rather than a new persisted field: `providerError` is written **if and only if** the model layer was classified as the failure, so its presence in `stageResults` is a faithful witness of that input. Nothing is invented. Only `code` and `httpStatus` are lost, and those were explicitly diagnostics rather than part of the classification.

## Why all three shipped green

Every existing provider-error test builds a `StageEvidence` with `stepError` already on it and asserts what the analyzer does with it. **None exercised the plumbing that puts it there** — so a unit test of the analyzer could not fail when the wire was cut.

This adds tests that drive the real `step-handlers` → `step-executor` path and the real judge payload builder. Each was verified to reproduce the exact bug it covers: restoring any of the three breaks fails its test and nothing else.
