---
"@mcpjam/sdk": minor
---

MCP Events (triggers), pinned to the working-group draft `28ec35e`. `MCPClientManager` reads a server's top-level `capabilities.events`, which the official client drops (`getEventsSupport`), and speaks `events/list`, `events/poll`, `events/subscribe`, `events/unsubscribe` and `events/stream`. Webhook signing secrets are redacted from every captured RPC frame, while the server still receives them exactly. The new `@mcpjam/sdk/events` entry has:

- the lifecycle coordinator for poll, webhook and push
- the in-memory inbox
- Standard Webhooks signing and verification
- delivery and run identities
- the draft and ChatGPT profiles, with every field tagged documented, observed or MCPJam policy
- the shared event-turn prompt

`runEventsConformance` checks a server against either profile, reporting MUST failures and SHOULD warnings separately.
