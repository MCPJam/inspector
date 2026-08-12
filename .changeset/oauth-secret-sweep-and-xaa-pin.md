---
"@mcpjam/sdk": patch
---

Pin the "no raw secret in a sanitized trace" criterion, and fence the XAA redact-into-live-state instance.

`sanitized-trace-contains-no-secrets.test.ts` asks the whole question at once: a sanitized projection carrying an access token, refresh token, ID token, client secret, authorization code, PKCE verifier, cookie, and OAuth `state` — in request URLs, headers, form and JSON bodies, response bodies, transport errors, info-log data, and the free-form flow error — must contain none of them. Each leak fixed in this series was found somewhere different; what they had in common was that nobody was asking about all of them together. It also asserts the trace stays useful (step, endpoint, and non-secret parameters survive) and that local dev still shows everything raw, which is the point of the inspector.

Separately, XAA's `sanitizeDiagnosticUpdates` redacts secrets and writes the result back into live flow state — structurally the same shape as the OAuth bug this series started from. It is inert today for two reasons, now written down next to the code: every redacted key is a display surface, and the only one read back as behavior (`lastResponse.body.status`) is a number the redactor does not touch. The key list is extracted as `REDACTED_DIAGNOSTIC_KEYS` and pinned by a test, so widening it to a credential field cannot happen as a one-word edit. This is a fence, not a refactor — the instance is provably harmless and does not need changing.
