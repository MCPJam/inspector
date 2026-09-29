---
"@mcpjam/inspector": patch
---

Ask MCPJam now runs on GPT-5.6 Luna instead of Claude Haiku 4.5. Each agent step re-sends the whole conversation, and Luna's input price is a fifth of Haiku's, with repeated prompt prefixes cached by the provider. The agent still runs on a model MCPJam chooses, and the Playground model picker is unaffected. Requires a backend that accepts the new model for Ask MCPJam turns.
