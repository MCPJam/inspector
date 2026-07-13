---
"@mcpjam/sdk": minor
---

Add `runXaaFlow`, a headless Cross-App Access (ID-JAG) flow driver: discovers the target authorization server (RFC 9728/8414), self-issues an ID-JAG with the in-process mock IdP mint, verifies it locally, redeems it at the AS (RFC 7523 jwt-bearer), and calls the MCP server with the resulting access token — reporting each step. Powers the forthcoming `mcpjam xaa` CLI command.
