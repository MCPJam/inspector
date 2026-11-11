---
"@mcpjam/inspector": patch
---

A saved server's accounts can be managed from the API, so CI can sign in itself and upload a fresh token to a named account before each run. The API serves `GET`, `PUT`, `PATCH` and `DELETE /projects/{projectId}/servers/{serverId}/accounts[/{account}]`, addressed by account id or name: `PUT` creates the account (`201`) or replaces its token in place (`200`, same id), `PATCH` renames it or makes it the default, and no route returns a token. Accounts uploaded this way are for hosted runs only. `POST .../oauth/import-tokens` is deprecated: its answers carry `Deprecation`, `Sunset` and `Link` headers, and an account it creates is for hosted runs only. A local connection refused because its account is for hosted runs only now says so, instead of pointing at the organization's export policy.
