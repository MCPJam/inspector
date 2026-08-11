---
"@mcpjam/sdk": minor
---

Fail loudly when a redaction sentinel reaches the OAuth state machine as a credential.

The factory already wraps every machine's request executor for SSRF, which makes it the one place that sees every executor result across all four protocol eras. It now also inspects `OAuthRequestResult.body` for the sentinel shapes this codebase's redactors emit (`[redacted]`, and the `abcd...[redacted]...yz` truncation form) in `access_token`, `refresh_token`, `id_token`, and `client_secret`, and throws `OAuthRedactedCredentialError` naming the field and a query/fragment-free request target. Clean results are returned unchanged, by identity.

The point is the seam, not the sentinel. A redaction sentinel is a non-empty string, so it passes every truthiness check and is spent as a credential; the first signal is a `401 invalid_token` from the resource server, three layers from the cause. `OAuthRedactedCredentialError` says what actually happened. The check reads `result.body` because that is where the real executor puts response fields — a guard written against `result.access_token` would look correct and never fire.

The match is deliberately narrow: an opaque token is an arbitrary string, so anything looser would break real logins. This is defense in depth for known shapes, not a substitute for keeping trace transformations out of live-data paths.
