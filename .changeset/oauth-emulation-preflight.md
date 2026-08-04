---
"@mcpjam/sdk": minor
---

OAuth client emulation: ordered attempt ladder, completion-safe redirects, and
the headless preflight runner (HP-43 step 5).

- **`runEmulatedOAuthPreflight`** (Node entry) executes an emulated client's
  authentication ladder against a real MCP server, headlessly. Outbound
  requests default to the hardened OAuth networking path (DNS pinning,
  total-deadline timeouts, body caps, redirect caps, cross-origin credential
  stripping). Reports three independent dimensions — `outcome`, `coverage`,
  and `comparison` (always `not_compared` here; golden comparison is a later
  step) — so a run can never imply parity on its own.
- **Attempt ladder** — `authModel` compiles into ordered rungs. Consecutive
  `oauth2-*` entries collapse into one OAuth attempt carrying their order as a
  registration preference; `api-key` and `none` stay in position. A static
  credential falls through to OAuth **only** on an evidence-backed 401, and an
  OAuth attempt falls through to the next strategy only while nothing has been
  committed on the wire.
- **Completion-safe redirects** — registration replays the captured
  `redirect_uris` in order with MCPJam's callback appended (a declared
  substitution); authorization and token legs always use MCPJam's callback so
  the code can be received and exchanged. Registration is retried with the
  callback alone **only** on a structured RFC 7591 `invalid_redirect_uri` —
  never on prose, a generic 4xx, a timeout, or an unparseable body.
- **Bounded, disclosed side effects** — at most two DCR registrations per run,
  reported in `sideEffects` alongside tokens issued.
- **Completion means a real token AND a valid authenticated JSON-RPC
  response**, not a bare 2xx.
- **Credentials are returned separately from diagnostics**; traces carry no
  tokens, codes, secrets, or PKCE values, including a caller-supplied static
  credential whose header name no generic redactor could know.
- `AuthorizationPlanInput.registrationPreference` lets an emulated client's
  order override the built-in AUTO precedence. Absent or empty leaves every
  existing caller's resolution byte-identical.
