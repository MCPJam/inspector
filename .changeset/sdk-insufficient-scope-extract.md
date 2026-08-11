---
"@mcpjam/sdk": minor
---

Export the SEP-2350 challenge extractor, so there is one copy of it.

The SDK recognized an upstream `InsufficientScopeError` (`isInsufficientScopeError`) and the Inspector server separately walked the same cause chain to pull the `WWW-Authenticate` fields off it. Two hand-maintained copies of one recognizer, and they had already drifted: only the host-side copy knew that `resourceMetadataUrl` arrives as a `URL` object at runtime rather than a string, so the SDK-side reader would have silently dropped the real production value.

`extractInsufficientScopeChallenge` and its `InsufficientScopeChallenge` type are now exported from `@mcpjam/sdk`, and both recognizers share one cause-chain walk with its cycle guard.

Behavior is preserved on both sides, including the difference between them: `isInsufficientScopeError` still returns `true` for a branded error carrying no challenge fields — the transport-fallback protection cares that the class was seen, not that it was actionable — while `extractInsufficientScopeChallenge` returns `undefined` for that case and keeps walking, so a branded but empty wrapper cannot hide a populated challenge deeper in the chain. Detection remains strictly by class brand or `.name`; an unrelated error that happens to carry a `requiredScope` field still cannot masquerade as a step-up challenge.
