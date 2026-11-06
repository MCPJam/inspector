---
"@mcpjam/inspector": patch
---

The MCP Apps sandbox origin can be set at runtime with `MCPJAM_SANDBOX_ORIGIN`, which the server serves to the browser and which wins over the build-time `VITE_MCPJAM_SANDBOX_ORIGIN`, so one image can serve every deployment. A value that is not an `http(s)` origin is ignored.
