---
"@mcpjam/inspector": minor
---

One typed builder for every OAuth initiation, so the same server cannot behave differently depending on which button started it.

Four production paths hand-rolled their own `initiateOAuth` options, and they disagreed. The hosted gate omitted `allowPathScopedIssuer`, `clientSecret`, `hasClientSecret`, `customHeaders`, `resourceUrl`, and `registrationMode`; the initial-connect path omitted `resourceUrl`. A server with a path-scoped authorization server or a configured resource indicator therefore authorized correctly from one entry point and failed from another — the most expensive shape an OAuth bug can take, because it only reproduces on one path and nobody knows which.

`lib/oauth/oauth-request.ts` now assembles every security-sensitive field once. Callers supply what they resolved from their own source — connect form, stored server record, hosted bootstrap — and the builder decides what reaches the wire. Intent is explicit (`connect`, `reconnect`, `hosted-connect`, `step-up`, `debug`, `emulation`); the four connect-like intents produce identical shared fields, and the intentional differences (step-up's widened scopes and challenge metadata URL) are asserted separately so they stay intentional.

`initiateOAuth` accepts only a `BuiltOAuthRequest` — a branded type nothing but the builder can produce — so a fifth divergent bag is a compile error rather than a bug report.

Connect-like intents now reject a configured `resourceUrl` that does not identify the configured MCP server, **before** the redirect, and report it as a configuration failure at each entry point. Previously the mismatch surfaced only after the user had left the page. `debug` and `emulation` may still carry nonconforming values, because exercising them is what those surfaces are for — but they have to say so by name, and the deviation is an observation rather than conformance.

`allowPathScopedIssuer` remains a per-server opt-in and reads as off when absent; it never becomes a default.

The proof is not options-object equality alone: the test also drives a built request into the real state machine and re-checks the wire invariants — same canonical resource, S256 PKCE, and one `redirect_uri` reused across registration and authorization.
