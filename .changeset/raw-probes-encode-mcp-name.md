---
"@mcpjam/sdk": patch
---

The 2026-07-28 protocol checks that send their own named request now write `Mcp-Name` the way a client must: plain ASCII as it is, and Base64-encoded when the name is not plain ASCII or looks like the `=?base64?…?=` marker. A server with such a tool, resource or prompt used to refuse the request, and the check behind it could not run.
