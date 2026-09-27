---
"@mcpjam/inspector": patch
"@mcpjam/sdk": patch
---

Emulated client templates now default to GPT-5.6 Luna instead of Claude Haiku 4.5.

`DEFAULT_TEMPLATE_MODEL_ID` is now `openai/gpt-5.6-luna`, and the MCPJam, Claude, Claude Desktop, AgentCore, Cline and Notion templates seed it. The bundled host-compat fallback catalog is regenerated from the backend, which made the same change. Claude Code keeps hosted Claude Haiku 4.5, because it runs the real Claude Code harness and needs an Anthropic model.

Luna is the persona driver's model already. It is a standard-tier hosted model, so guests and free organizations can run a new client's default model without meeting a frontier-model gate.

Existing clients keep their saved model. "Client update available" offers the new default as an opt-in migration. The Playground's default compare lineup (Claude, ChatGPT, Cursor) now shows two Luna clients.
