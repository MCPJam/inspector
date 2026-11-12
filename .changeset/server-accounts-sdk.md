---
"@mcpjam/sdk": minor
"@mcpjam/inspector": patch
---

The SDK manages a saved server's accounts. It adds `listServerAccounts`, `getServerAccount`, `uploadServerAccountTokens`, `updateServerAccount` and `deleteServerAccount` with matching operations, each addressing an account by id or name, and none returns a token. `uploadServerAccountTokens` answers `created: true` when the upload made the account and `created: false` when it replaced the token of an existing one. Listing, reading and deleting accounts are tools on the hosted MCP server, and a turn of `POST /projects/{projectId}/agent` can list and read them. Uploading a token and updating an account are not tools: a token in a tool argument reaches the model before anyone approves the call, and the default decides which account a run with no saved account choice signs in as.
