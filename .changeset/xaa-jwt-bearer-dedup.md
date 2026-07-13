---
"@mcpjam/inspector": patch
---

Remove the XAA server's duplicated `buildJwtBearerRequest` (and its `formUrlEncode`/`encodeBasicClientAuth` helpers); the server now consumes the single-source implementation from `@mcpjam/sdk`. No behavior change — the debugger's `/proxy/token` endpoint and the connect-page mint use the same builder as the CLI.
