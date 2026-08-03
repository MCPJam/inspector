---
"@mcpjam/sdk": minor
---

Add `HostConfigOAuthProfileV2` — the OAuth client-emulation profile schema
(HP-43 step 3). V1 canonicalization is frozen: V1 rows canonicalize
byte-identically forever, are never rewritten to V2, and reject V2-only
fields, so every existing content-addressed hash stays valid.

V2 adds two evidence-backed fields and one semantic change, all in service of
byte-exact wire replay:

- `scopeRequest` — how the client populates the authorization `scope`
  parameter: `omit` | `fixed` (with the captured scope list) | `challenge` |
  `all-supported`. Discriminated so "fixed" cannot be recorded without its
  scopes.
- `tokenEndpointAuthMethod` — `none` | `client_secret_basic` |
  `client_secret_post`, a closed set.
- `dcrIdentity.redirectUris` preserves the captured registration order and
  rejects duplicates (V1 deduped + sorted) — the emulator replays the DCR
  body byte-exactly, array order included. Captured scope order is likewise
  preserved verbatim and duplicates rejected.

Absent V2 fields are omitted from the canonical JSON — never
null/default-filled. `canonicalizeOAuthProfile` dispatches on
`profileVersion` (1 | 2, anything else fails loudly) and remains the single
standalone entry point catalog rows are resolved through.
