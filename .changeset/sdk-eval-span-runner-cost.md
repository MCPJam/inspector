---
"@mcpjam/sdk": minor
---

Eval trace llm spans now carry `cost` for their one provider call: the dollars the provider reported to the runner, such as OpenRouter's `usage.cost`, recorded as runner-reported (`source: "runner_reported"`), not provider-reported, because MCPJam cannot verify them; or "unavailable" with a reason when the provider reported none. The evidence marks its usage as runner-supplied and the call as customer-funded. The runner holds no rates, so it never estimates; MCPJam prices runner usage on its own side.
