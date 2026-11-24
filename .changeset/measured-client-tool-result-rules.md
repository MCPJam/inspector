---
"@mcpjam/sdk": patch
"@mcpjam/cli": patch
---

The bundled host catalog now records which part of a tool result each measured client shows its model: Claude Desktop is `"fallback"`, Claude Code and Codex CLI are `"preferred"`. Local `mcpjam test --host claude-desktop` now sends the model the text Claude Desktop sends, without structuredContent or `_meta`.
