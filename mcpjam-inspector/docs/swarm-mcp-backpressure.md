# Swarm MCP backpressure: first implementation increment

Design: https://github.com/MCPJam/mcpjam-backend/pull/1538

Preserve upstream throttle metadata before adding admission or retries. Keep
existing tool-call execution, authentication and protocol negotiation behavior.
Shared admission placement is provisional: verify direct-manager and hosted-proxy
egress before choosing a coordinator or adding Convex calls per MCP request.

## TDD checklist

- [ ] A tool-call 429/503 preserves the raw Retry-After header through the SDK
  transport, including both delta-seconds and HTTP-date values.
- [ ] Missing/malformed headers do not invent a retry policy, and a rejected
  tool call is sent only once.
- [ ] Successful results, auth handling and HTTP 400 protocol errors retain
  existing behavior.
- [ ] Document direct and hosted egress coverage and remaining metadata gaps.

No shared pacing, cooldown enforcement or automatic tool-call replay is enabled
by this increment. Screenshots and recording remain pending; a metadata-only
change has no new user-visible flow, so an explicit exception is required before
requesting review of this increment without visual evidence.
