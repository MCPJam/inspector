---
"@mcpjam/sdk": minor
---

Export the browser-safe XAA/ID-JAG primitives as the single source of truth: `decodeJWTParts`/`DecodedJwtParts` (header+payload+signature, promoted alongside the existing `decodeJWT`), the negative-test constants (`NEGATIVE_TEST_MODES`, `DEFAULT_NEGATIVE_TEST_MODE`, `XAA_IDP_KID`, `isNegativeTestMode`), and the registration-strategy primitives (`XAA_REGISTRATION_STRATEGIES`, `DEFAULT_XAA_REGISTRATION_STRATEGY`, `normalizeXaaRegistrationStrategy`) — all from both `@mcpjam/sdk` and `@mcpjam/sdk/browser`. Adds a built-graph guard test that fails if the browser entry ever pulls a Node builtin.
