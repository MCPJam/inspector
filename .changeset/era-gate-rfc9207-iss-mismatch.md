---
"@mcpjam/sdk": patch
---

Scope the RFC 9207 authorization-response `iss` mismatch rejection to the protocol era that mandates it. `MUST validate a present iss` is introduced by SEP-2468 in the 2026-07-28 draft; 2025-11-25 and earlier never mention `iss`, RFC 9207, or issuer identification, so enforcing there applied a rule the selected version does not contain. A mismatch still hard-blocks before code redemption on 2026-07-28; pre-draft flows now surface it as a non-blocking warning and complete.

This completes the era gating started in #3441, which scoped only the reject-on-absence row and deliberately left the present-but-mismatched row firing on every version.

Warning-not-blocking on pre-draft eras is narrow by design: PKCE S256 is already mandatory there, the token endpoint always comes from the recorded metadata (never the callback, so a hostile `iss` cannot redirect the code), and tokens are persisted issuer-keyed to the recorded issuer. RFC 9207 Section 2.4 leaves an unadvertised `iss` to local policy. `validateAuthorizationResponseIssuer` gains an optional `enforcePresentIssMismatch` that defaults to enforcing, so an omitted flag fails closed.

Mismatch diagnostics now name both issuers — the recorded one and the one returned on the callback — because an exact comparison fails on differences too small to infer from "does not match" alone.
