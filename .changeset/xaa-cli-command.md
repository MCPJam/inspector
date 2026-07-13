---
"@mcpjam/cli": minor
---

Add `mcpjam xaa run`, a headless Cross-App Access (ID-JAG) debugger that mirrors `mcpjam oauth login`. It discovers the target authorization server, self-issues an ID-JAG, redeems it at the AS (RFC 7523 jwt-bearer), and calls the MCP server with the resulting access token — streaming progress to stderr and printing a structured per-step report. Exits non-zero when the flow does not complete (e.g. the AS could not validate a self-issued ID-JAG whose issuer it cannot reach).
