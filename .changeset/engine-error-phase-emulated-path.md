---
"@mcpjam/inspector": patch
---

The emulated engine says which side of the model handover it died on

Provider-error attribution reads `MCPJamEngineErrorEvent.phase` to decide whether a failed turn was ours or the provider's. `runChatEngineLoop` set it at none of its three emit sites, so `failedLayerForEngineError`'s no-phase default answered for the entire emulated path: every failure on it resolved to `model`. On the hosted eval path `model` becomes a `providerError`, which WITHDRAWS the trial's failures — so an Inspector bug did not merely get mislabelled, it deleted the evidence of whatever else the trial had found.

The outer catch is the one that matters. It opens before any preparation and covers the trace-payload `structuredClone`, message scrubbing, the guest-IP hash, tool narrowing, `emitTurnStart`, pending-approval processing and the MRTR resume pre-phase — all of which can throw without a model ever being contacted. It now reports from a `modelInvoked` flag mirroring the harness's, set at the handover rather than on a successful response, so a provider that rejects the request outright still reads as the model's failure while a preparation bug reads as ours. The two inner emitters are strictly post-response and say `"stream"` outright; neither needs a flag to know it.

**Two comments were wrong, and both understated the gap.** `failedLayerForEngineError` claimed the over-broad-catch problem "holds for the chat engine and not for the harness" — the chat engine's catch is exactly as broad, it just had no phase to report — and justified its default with "every emitter that omits a phase today is a real stream failure", when this engine's three emitters were the counter-example. A test carried the same premise. The default is unchanged and still `model`, but it now governs only emitters outside the two in-repo engines, and the reason given for it is no longer a fiction.

**The new test sits below the existing mock boundary, deliberately.** `provider-error-plumbing.test.ts` `vi.mock`s `driveHostedEvalTurn`, so it starts above the code this fixes and would pass with the bug fully present; `provider-error-attribution.test.ts` unit-tests the decision without ever running an engine. The new suite drives the real engine through its public entry point and reads the events it emits. Its first draft was itself vacuous — an incomplete `logger` mock threw inside the non-OK-response site, so that case fell through to the outer catch and asserted the right string from the wrong place — so it now pins the emitting site by `httpStatus`, not just the answer.

Mutation-checked three ways: dropping the outer emitter's phase fails the three tests that route through it; dropping the response site's fails exactly the one that names it; and marking the handover on success instead of at the request flips the transport-failure case to `setup`, failing only the test that states the timing rule.
