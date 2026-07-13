---
"@mcpjam/sdk": minor
---

Add `createInProcessXaaExecutor` (Node entry) — the CLI's in-process implementation of the XAA `XAARequestExecutor` seam. It services the three MCPJam-owned mint routes in-process using the node mint (`/authenticate` → `issueMockIdToken`, `/token-exchange` → decode assertion + `issueNegativeIdJag`, `/proxy/token` → `buildJwtBearerRequest` + `executeOAuthProxy`, wrapping the upstream `{status, body}`), and routes external AS/MCP requests through the hardened OAuth proxy with the configured timeout and HTTPS/private-target policy. The internal-route switch is exhaustive (404 on an unknown route). This lets the CLI drive the shared browser-safe state machine without a running inspector server; a parity test drives the engine to completion through it.
