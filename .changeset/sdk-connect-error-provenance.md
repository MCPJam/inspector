---
"@mcpjam/sdk": patch
---

Report a refused connection as a refused connection.

Connecting to a host that nothing is listening on classified as `transport/fetch_failed` — "we could not reach it", which tells a developer nothing they did not already know. The specific reason was present the whole time and discarded three separate ways:

- The HTTP connect paths rethrew a readable summary with no `cause`, so the underlying error object (and its errno) was unreachable. Both throw sites now preserve it, and the combined Streamable-HTTP+SSE failure additionally keeps the Streamable attempt on a non-enumerable `streamableCause` for when the two transports failed for different reasons.
- `extractNodeErrno` returned the first string `code` it found and stopped. A wrapper that stamps its own domain code on the outside of the chain — the MCP SDK's `ERA_NEGOTIATION_FAILED` — therefore shadowed the real `ECONNREFUSED` one hop below it. Unrecognized codes no longer end the walk; they are still returned when the chain holds no errno at all.
- `describeError` matched undici's generic `fetch failed` before looking for an errno spelled out in the same message ("... connect ECONNREFUSED 127.0.0.1:9999"). An errno in the text now wins over the generic phrase.

A refused port now resolves to `transport/econnrefused`, whose guidance names the actual next step. One documented limit remains: a server pinned to Streamable HTTP (`disableSseFallback`) still reports `transport/fetch_failed`, because the upstream era-negotiation probe drops both the cause and the errno text before MCPJam sees the failure.
