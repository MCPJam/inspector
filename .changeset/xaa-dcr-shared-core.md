---
"@mcpjam/sdk": minor
---

Extract the OAuth debug state machines' duplicated Dynamic Client Registration (RFC 7591) logic into a shared, exported helper, and add the XAA (ID-JAG) client-identity building blocks.

New exports (browser + node entry points):

- `buildDynamicClientRegistrationRequest` / `executeDynamicClientRegistration` — the DCR request builder and executor previously inlined in all three debug OAuth machines. The executor now redacts credential-bearing fields (`client_secret`, `registration_access_token`, `access_token`, `refresh_token`) from every diagnostic surface (lastResponse, HTTP history, info logs); raw credentials travel only through the returned `credentials`/`clientInfo`. A 2xx response with a null/non-object body is now classified as `invalid_response` and takes the pre-registered-fallback path instead of proceeding with undefined credentials.
- `getXaaDebugClientMetadata`, `evaluateIdJagClientMetadata`, `ID_JAG_GRANT_PROFILE`, `TOKEN_EXCHANGE_GRANT`, `JWT_BEARER_GRANT`, `XAA_DEBUG_CLIENT_ID_METADATA_URL` — ID-JAG (draft-ietf-oauth-identity-assertion-authz-grant-04) client metadata builder and evidence evaluator for the XAA debugger.
- `validateClientIdMetadataUrl` — Client Identifier URL validation updated to draft-ietf-oauth-client-id-metadata-document-02: requires a path component, rejects userinfo/fragment/raw dot segments, accepts a query, and returns the original string unchanged (simple string comparison identity; the previous CIMD validator `URL.toString()`-normalized the URL).
- `OAuthProxyRequest.redirect` / `OAuthHttpRequest.redirect` (`"follow" | "manual"`) — explicit redirect control for proxy execution. `httpsOnly` still always forces `manual` and cannot be weakened; omission preserves the historical `follow`.

The three debug OAuth machines keep their orchestration, transitions, fallback behavior, and user-facing error strings; the intentional visible changes are the credential redaction, the truncated-secret info log becoming a `Client Secret Issued: true` boolean, and the invalid-response classification above.
