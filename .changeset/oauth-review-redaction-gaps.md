---
"@mcpjam/sdk": patch
"@mcpjam/inspector": patch
---

Close four ways a credential could still reach a sanitized OAuth trace.

Each was found by probing the redactor with the shape rather than by reading it, and each is now pinned by a test that fails on the unredacted string:

- **Underscore-prefixed credential names.** `user_access_token=…` in a query string or error body did not match, because the name heuristic anchored on a word boundary and `_` is a word character. Names are matched on `_`-delimited segments now, so a vendor prefix no longer defeats the check.
- **Colon-bearing keys.** A key containing `:` let ordinary prose be parsed as a structured field record and skip the field-name policy entirely. The key charset for that detection no longer admits `:`.
- **Credential-shaped names outside the enumerated set.** `session_token`, `refresh_secret` and friends were not on the sensitive-field list, so a body containing them serialized in the clear. The heuristic now covers `token`/`secret`/`password`/`credential`/`cookie`/`auth`/`api_key` as name segments — with an explicit exemption for descriptive suffixes (`_type`, `_endpoint`, `_supported`, `_uri`, `_methods`, …) so `token_type: "Bearer"` and `token_endpoint` stay legible. Redacting those would make a trace useless for the thing it exists for. The exemption is on the NAME alone — the value behind it is still sanitized, so a descriptive-looking `session_token_url=…%3Faccess_token%3D…` cannot carry a credential through a name the policy waved past.
- **URL userinfo.** `https://user:s3cret@auth.example.com/token` survived `sanitizeOAuthUrl`, because `new URL().toString()` preserves credentials in the authority. They are cleared before serialization, and HTTP-history entries now route their `request.url` through the same sanitizer instead of copying it verbatim.

`sanitizeTraceErrorMessage` takes `maxLength`/`maxScanned` options so a long stack is redacted in one pass rather than line by line — line-splitting was itself the leak, since a credential spanning a wrap escaped every per-line scan.

Also in this pass: the connect-time `resourceUrl` is checked for provenance against the configured server URL before it is used (`selectStoredResourceUrl`), so a stale or foreign stored value cannot bind the flow to a resource the user never configured; it is rejected before the browser is redirected.
