---
"@mcpjam/sdk": minor
"@mcpjam/cli": patch
"@mcpjam/inspector": patch
---

A host config can now record which part of a tool result its client shows the model: `modelVisibleMcpToolResults.structuredContent` is `"fallback"` (the text, or structuredContent when content is empty, as Claude Desktop does), `"preferred"` (structuredContent when present, as Claude Code and Codex CLI do) or `"both"`. When it is set, the model gets that part as plain text, never the result's `_meta`, and the raw result stays available to widgets and traces. Hosts without it, and every harness run, keep the projection they had.

`EvalSuite.runWithClient` and other API callers now tell the server they understand the key, so clients that carry it reach this SDK intact; older SDKs are sent the config without it. Local `mcpjam test --host <id>` takes the catalog row's value too.
