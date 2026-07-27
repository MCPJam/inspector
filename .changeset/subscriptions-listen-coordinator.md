---
"@mcpjam/sdk": minor
---

Add an era-neutral subscription coordinator for MCP 2026-07-28
`subscriptions/listen` (`SubscriptionCoordinator`, new exports only). Modern
connections drive an explicit `client.listen(filter)` stream — requested vs
acknowledged filter tracked separately, active only after
`notifications/subscriptions/acknowledged`, notifications demultiplexed by
subscription id, graceful/remote/local close reasons distinguished, bounded
re-listen (never resume) after unexpected loss. Legacy connections keep the
existing list-changed handlers plus per-URI `resources/subscribe`.
`ManagedMcpClient` gains an optional `listen` passthrough.
