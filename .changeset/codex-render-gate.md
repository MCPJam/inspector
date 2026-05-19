---
"@mcpjam/inspector": patch
---

Chat: don't render widget iframes for hosts that don't advertise the MCP UI extension. Codex (elicitation-only CLI) now correctly falls through to the plain tool-result row instead of mounting an iframe for tools that declare `_meta.ui.resourceUri` or `openai/outputTemplate`. Apps-SDK hosts that keep the SDK-default UI extension (ChatGPT, Copilot, MCPJam, Claude) are unaffected.

The render gate keys off the host's persisted `clientCapabilities`, not its `hostStyle` — user edits to capabilities are honored. A future `window.openai` flag on `HostConfigInputV2` will be OR-ed into the same gate.
