---
"@mcpjam/inspector": patch
"@mcpjam/sdk": patch
---

Hosted MCP connections send a User-Agent again (`MCP-Inspector/1.0`), so servers behind firewalls that block requests without one can connect.
