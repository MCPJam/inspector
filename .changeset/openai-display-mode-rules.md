---
"@mcpjam/inspector": patch
"@mcpjam/sdk": patch
"@mcpjam/widget-react": patch
---

ChatGPT and Codex clients with the Display modes extension on follow OpenAI's display-mode rules for the Apps plugin extensions host (entrypoint Apps and the model-invoked Apps the extension workspace owns): an App whose resource declares both inline and fullscreen starts fullscreen, a preference picks the starting mode without narrowing the others, and an entrypoint App that says at initialization it can't show fullscreen is refused with a Logs entry instead of being forced fullscreen. Other MCP Apps keep the existing display-mode negotiation.
