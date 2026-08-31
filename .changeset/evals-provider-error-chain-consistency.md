---
"@mcpjam/sdk": patch
---

Withdrawing a provider-blocked failure no longer leaves the chain arguing with itself

Two follow-ups on the withdrawal added in the previous round.

**The cascade ran before the withdrawal.** The positional pass reads `failed` rows to decide which later stages "never ran". Withdrawing a provider-blocked failure *after* it had run left `call`, `response` and `userValue` still saying `earlierStageFailed` while no stage failed and no `firstFailedStage` existed — three rows citing a failure the chain no longer records.

The withdrawal now happens first, so the cascade sees the rows as they will actually be reported: a provider outage marks the later stages `providerError`, which is *why* they were not measured, rather than blaming a stage that is no longer failed. A failure the provider did **not** explain still cascades exactly as before — `unexpectedToolCall` survives the withdrawal, stays the first failed row, and the stages after it still read `notReached`. The cascade is repaired, not disabled.

**The reason's label spoke for the run.** It read *"the model provider failed the call, so the run never reached the server"* — but `providerError` is applied per row, so a multi-turn iteration whose provider died at turn 4 keeps its earlier measured rows. The run-level claim would sit directly beside a `call: passed` that disproves it, and send a reader after the wrong timeline. It now says *"…so this stage was never measured"*, which is true of the row it labels.

Mutation-checked: restoring the old ordering reproduces the self-contradicting chain, and restoring the run-level wording fails the label's scope test.
