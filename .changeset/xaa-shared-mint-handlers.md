---
"@mcpjam/sdk": minor
---

Extract the mock-IdP mint handler logic into pure handler cores (`handleXaaAuthenticate`, `handleXaaJsonTokenExchange`, `handleXaaTokenExchangeGrant` in `xaa/mint/handlers.ts`, node entry only). The cores return `{ status, body }` and own the mint contract; transport concerns (parsing, negative-test-mode resolution, org gating, hosted-issuer forwarding, headers) stay in the adapters.

This change wires the CLI's in-process executor to the cores; a follow-up change rewires the inspector server routes to the same cores (until then the server keeps its own equivalent handlers). The executor now delegates its `/authenticate`, `/token`, and `/token-exchange` routes to the cores, which aligns it with the server's tested behavior (deliberate parity fixes, not a pure refactor):

- `/authenticate` applies the server's demo-identity defaults (`user-12345` / `demo.user@example.com`) instead of minting an empty-subject ID token, and returns the server's rich body (`{ id_token, token_type, expires_in, user }`) instead of a bare `{ id_token }`.
- `/token-exchange` returns the server's rich body (`{ id_jag, token_type, issued_token_type, expires_in, negative_test_mode }`) instead of a bare `{ id_jag }`, and its malformed-assertion error messages now match the server's.
- `/token` (RFC 8693) keeps its already-identical success body but adopts the server's more specific OAuth error descriptions and check order.

The shared XAA state machine reads only the stable keys (`id_token`, `id_jag`, `access_token`), so existing flows are unaffected.
