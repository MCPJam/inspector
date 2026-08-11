---
"@mcpjam/sdk": minor
"@mcpjam/inspector": minor
---

Give OAuth trace redaction one owner, and make `state` a secret in traces.

The redaction policy — which field names are secret, what a redacted value looks like, how a free-form error string is scrubbed — existed in six places, and the copies had already drifted. The SDK's sensitive-field set omitted `state` while the client's included it, so the same value was published or redacted depending on which code path rendered it; the SDK's error-string redactor was a naive subset that turned "Bearer token is expired" into "Bearer [redacted] is expired", destroying the word that says what went wrong.

There is now one source of truth: `oauth/state-machines/trace-redaction.ts` in the SDK, exported from `@mcpjam/sdk/browser`. The inspector's `lib/oauth/trace-redaction.ts` re-exports it and adds the `SANITIZE_OAUTH_TRACES` gate; `mcp-oauth.ts`, `oauth-trace.ts`, and `App.tsx`'s OAuth-debugger error boundary all call it instead of their own copies. The surviving error redactor is the debugger's, which already handled URL userinfo, named parameters, echoed `Authorization` headers, JSON credential fields, and truncation tails — and preserves diagnostic wording.

Three leaks closed on the way:

- **`state` in sanitized traces.** It is not a bearer credential, which is why it was easy to leave out, but a still-live `state` is the CSRF correlation secret for an in-flight authorization. It is now redacted as a structured field, in URL queries, in form and JSON bodies, and inside error strings. Diagnostics use the new `describeOAuthStateMatch`, which reports `statePresent`/`stateMatched` instead of the nonce.
- **Request URLs in HTTP history.** `sanitizeHttpHistoryEntry` redacted headers and bodies but not `request.url`, so every recorded authorization request kept its `state` (and a callback URL its `code`).
- **Prose reshaped into fields.** `URLSearchParams` never fails, so `"rejected: access_token=ntn_live"` was parsed into a single field whose key (`"rejected: access_token"`) is not in the sensitive set — losing redaction the plain-string path would have applied. Reshaping now requires parameter-shaped keys; everything else goes to the error-string redactor.

Telemetry redaction stays separate and is renamed to `redactForTelemetry` (`src/telemetry-redaction.ts`). It over-redacts deliberately and is length-capped for Sentry; merging it with the display redactor would weaken one or the other. `redactSensitiveValue` remains exported as a deprecated alias so external consumers do not break.

A ratchet test (`lib/__tests__/oauth-redaction-ratchet.test.ts`) keeps redaction identifiers inside the trace modules. Vitest runs in CI; the lint workflow only runs typecheck and build, so an eslint rule would never have fired.
