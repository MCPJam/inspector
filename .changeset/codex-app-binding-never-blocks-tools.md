---
"@mcpjam/inspector": patch
---

Hosted Codex tool calls no longer fail with "Forwarding execution refused (control_409)" when MCPJam cannot bind a result's MCP App to the account that produced it. The tool always runs and its result reaches the model. Only tools that render an App are bound, and an App whose account cannot be confirmed shows a note asking you to send the message again, instead of loading with whichever account is selected now.
