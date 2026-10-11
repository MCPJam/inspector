---
"@mcpjam/sdk": patch
---

The Claude and Claude Desktop templates no longer allow MCP Apps to load from `esm.sh` without declaring it. Real Claude blocks those loads, so an App that relied on them worked in MCPJam but broke in Claude.
