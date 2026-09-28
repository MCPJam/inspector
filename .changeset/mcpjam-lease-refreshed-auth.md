---
"@mcpjam/sdk": minor
---

MCPJam-hosted inference (`mcpjam/…` models) can now mint leases as a caller whose credential refreshes — a CLI login's session — instead of only with a fixed `sk_` key. Pass `mcpjamAuth: { getAuth, headers? }` to `HostRunner` (inherited by every clone) or `createModelFromString`, or bind a `McpjamModelLeaseScope` to it with `new McpjamModelLeaseScope({ auth })`. `getAuth` is read for every mint, mint retry and revoke; the optional `headers` go to MCPJam's lease API only, never to the model proxy or a provider, and cannot replace `authorization` or `content-type`. A key and a callback together are refused rather than resolved by precedence, and scopes key auth-callback clients by identity, so two auth contexts never share a lease. The fixed-key path and its `MCPJAM_API_KEY` fallback are unchanged.

`McpjamLeaseError` now keeps the refusal's structured `details`, and the new `classifyMcpjamLeaseError` reads it: a billing code wins wherever it appears — including nested under an auth-shaped `FORBIDDEN` envelope — so a free-allowance or spend-budget refusal is reported as `billing`, not as bad credentials.
