---
"@mcpjam/sdk": patch
"@mcpjam/inspector": patch
---

A model-provider failure is attributed to us, not filed against the server

20 trials in one audited prod window failed on "credit balance too low… Anthropic API". The step errored, the asserts were skipped, and the chain ended `userValue: notMeasured / noEvidenceCaptured` with **no failure category at all** — our provider's outage presented as an unattributed server failure, in a report card whose entire job is to say whose side broke.

The layer that failed is now tagged at the catch site and carried into the chain. `providerError` marks the stages a model-call failure left blank, and `categoryFor` files the run under `setup` — the existing bucket for our own side breaking, so no new category was needed.

**Classified structurally, never by reading the message.** `drive-hosted-eval-turn.ts` already knows which layer it is in: `failTurn` is the engine's stream, `mapThrownTurnError` names its own call site, and "pre-turn setup" is the one that never reached the model. A text classifier would be one provider's wording away from mis-attributing a whole class of run. The engine's `code` and `httpStatus` ride along as diagnostics for a reader, and are deliberately _not_ part of the decision.

Three boundaries are deliberate:

- **A stage with its own observation keeps its own row.** A provider dying at turn 4 does not un-observe turns 1–3. What is re-labelled is a stage that measured nothing, plus — see "withdraws the failures it made unknowable" below — a `failed` row whose verdict rests on an *absence* the outage could equally well explain. A verdict resting on something actually observed always stands.
- **Never `failed`.** A run that could not be attempted has measured nothing about the server, and inflating a server failure rate with our own outage is the mis-attribution this reason exists to prevent.
- **A broken grader still outranks it.** `evaluator` is never folded into another category.

`providerError` is broader than its name: it covers a provider outage, an exhausted credit balance, a rate limit, and our own spend guardrails. What they share is that _our_ side of the call broke, which is the only distinction the chain needs to stop blaming the server. That is stated in the reason's own docblock.

Analyzer 7 → 8. This bump moves `STAGE_REASONS`, and the backend mirror already carries the member — it shipped deliberately ahead of this change — so nothing quarantines during the deploy window.

**Stated limitation, unchanged:** the legacy verdict still counts these trials failed. Changing verdict population is a customer gate change and remains deferred behind its own product decision and release note.
