---
"@mcpjam/sdk": minor
---

Export the browser-safe XAA/ID-JAG primitives as the single source of truth: `decodeJWTParts`/`DecodedJwtParts` (header+payload+signature, promoted alongside the existing `decodeJWT`) and the negative-test constants (`NEGATIVE_TEST_MODES`, `DEFAULT_NEGATIVE_TEST_MODE`, `XAA_IDP_KID`, `isNegativeTestMode`) — all from both `@mcpjam/sdk` and `@mcpjam/sdk/browser`. (The registration-strategy primitives ship under their unified names — see the unified-registration-vocabulary changeset.) Adds a built-graph guard test that fails if the browser entry ever pulls a Node builtin.
