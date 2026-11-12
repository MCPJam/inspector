---
"@mcpjam/sdk": patch
---

Host templates now default to current, cheap models. Gemini uses `google/gemini-3.8-flash` (it named `google/gemini-3-pro`, which MCPJam does not serve). Claude, Claude Desktop, Cursor, VS Code, AgentCore, Cline and Notion use `anthropic/claude-haiku-5.5`. ChatGPT, Copilot, Copilot CLI, Goose, Slack, n8n and Perplexity use `openai/gpt-6-luna`. Mistral uses `mistralai/mistral-small-2603`.
