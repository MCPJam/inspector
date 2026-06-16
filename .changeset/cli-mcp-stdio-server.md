---
"@mcpjam/cli": minor
---

New `mcpjam mcp` command runs MCPJam as an MCP server over stdio, so MCP clients without shell access (Claude Desktop, Claude Code, Cursor, custom agents) can use the local testing engine as tools. The server exposes 14 tools: persistent connection management against servers under test (`connect_server`, `disconnect_server`, `list_servers`, `server_info`, `ping_server`), target exercising (`list_tools`, `call_tool`, `list_resources`, `read_resource`, `list_prompts`, `get_prompt`), a per-connection notification buffer (`get_notifications`, covering log messages, progress, and list_changed events that one-shot CLI runs can't observe), and stateless diagnostics (`server_doctor`, `probe_server`). Connections stay open across tool calls; all status output goes to stderr so stdout stays clean JSON-RPC.
