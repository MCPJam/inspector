---
"@mcpjam/sdk": minor
---

Add the SDK core for the MCP 2026-07-28 multi-round-trip (`input_required`) interaction — the manual driver that lets `tools/call`, `prompts/get`, and `resources/read` return embedded elicitation requests, collect input, and retry the original operation (spec §12). New exports only.

- **Manual mode.** The manager constructs its client with `inputRequired: { autoFulfill: false }`, so an `input_required` result surfaces to MCPJam's own driver instead of the SDK's automatic one.
- **Serializable stepper** (`mrtr-driver.ts`): `executeInputRequiredLeg` / `resumeInputRequiredOperation` operate on a data-only `MrtrOperationState` (stable id, method, immutable original params, round, echoed `requestState`, current round's pending requests) — never a client, promise, closure, or `AbortSignal` — so hosted surfaces can persist and resume it. `runInputRequiredOperation` layers a local/CLI convenience loop on top.
- **MCPJam owns the round cap** (`DEFAULT_MAX_MRTR_ROUNDS = 10`, persisted in the state); exceeding it raises the upstream `SdkError(InputRequiredRoundsExceeded, …, { rounds })` shape. Guards `isMaxRoundsExceeded` / `isUnsupportedResultType`.
- **Per-round replacement** of `inputResponses` (never accumulated) with byte-exact `requestState` echo; state-only, inputs-without-state, and no-state rounds all supported. Response maps are built with a null prototype (server keys are untrusted).
- **Undeclared-request rejection (Decision 8):** embedded `roots/list` / `sampling/createMessage` and unsupported elicitation modes are rejected at the result — before any UI — via `MrtrUndeclaredInputError` / `MrtrUnsupportedElicitationModeError`.
- **Strict self-validation (§12.1.11):** accepted elicitation content is validated against the request's `requestedSchema` (unknown dialect → invalid, not fail-open) before it is sent; decline/cancel are responses, not errors.
- **New `requestWithSchema` seam** on `ManagedMcpClient`, `OfficialSdkClientAdapter`, and the `LogLevelMetaClient` decorator (which injects the modern per-request logging `_meta`) — the type-correct explicit-schema path for the loop.
- **Three verbs wired** through per-server MRTR input collectors (`setMrtrInputCollector`) without regressing Phase-3 helper semantics: resource reads keep the response cache, prompt/tool legs carry the per-request log level, and the final tool result is re-validated against its output schema. `buildCapabilities` now advertises `elicitation` when an MRTR collector is registered; roots/sampling stay unadvertised.
