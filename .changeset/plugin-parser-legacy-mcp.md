---
"@mcpjam/sdk": minor
---

Under the `openai-compatible` profile, `parsePluginBundle` reads the MCP servers of Codex and Claude packages: the file or inline object a legacy manifest's `mcpServers` names, else `.mcp.json`. Each entry is rewritten into a strict Agent Plugins entry (`http` becomes `streamable-http`, an absent type is inferred from `command` or `url`, `cwd: "."` becomes the plugin root, `${CLAUDE_PLUGIN_ROOT}` and `${CLAUDE_PLUGIN_DATA}` become the portable placeholders) and then validated by the same rules as a root `mcp.json`. A disabled entry, or one mixing stdio and HTTP fields, is skipped on its own with its reason; a root `mcp.json` is still never inferred or rewritten.
