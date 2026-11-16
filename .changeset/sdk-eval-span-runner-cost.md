---
"@mcpjam/sdk": minor
---

Eval trace llm spans now carry `cost` for their one provider call: the dollars the provider reported, such as OpenRouter's `usage.cost`, or "unavailable" with a reason when it reported none. The evidence marks its usage as runner-supplied and the call as customer-funded. The runner holds no rates, so it never estimates; MCPJam prices runner usage on its own side.
