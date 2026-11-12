---
"@mcpjam/inspector": patch
---

MCP Apps render again when the Inspector runs in Docker or behind an SSH tunnel or port forward. Each App's sandbox now loads through the Inspector's own port and keeps its own origin.
