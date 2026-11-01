---
"@mcpjam/inspector": patch
---

Every model picker now offers Add a provider on a search with no match, not just the eval pickers. Pickers scoped to a project (the eval pickers, the case run sheet, the environment composer and the judge pickers) open that project's organization's AI providers, or offer nothing when the viewer can't manage them; the chat and client builder pickers use the active project's organization. Off the organization key policy, the explanation now reads "Only models MCPJam runs and models from your providers are listed.", since the picker also lists local Ollama models, and your own API keys and custom providers when the organization has no providers of its own.
