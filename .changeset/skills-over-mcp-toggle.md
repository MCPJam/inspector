---
"@mcpjam/inspector": patch
---

Clients now have a Skills over MCP switch in the Protocol tab. When it is on, the client tells servers it supports Skills over MCP, so chat can load the skills a server serves; when it is off, the client does not. The switch works the same in local and hosted mode. Local mode used to send it for every client; now, as in hosted mode, only the MCPJam client has it on by default.
