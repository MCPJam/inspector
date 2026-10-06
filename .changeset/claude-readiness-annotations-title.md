---
"@mcpjam/sdk": patch
"@mcpjam/inspector": patch
---

Claude directory readiness now requires `annotations.title` on every tool. A top-level `title` alone no longer passes `claude.tools.title-present`, because Claude's directory listing reads only the annotation and flags every tool without one as "Missing title annotation". MCPJam's own MCP server now sets `annotations.title` on every tool too.
