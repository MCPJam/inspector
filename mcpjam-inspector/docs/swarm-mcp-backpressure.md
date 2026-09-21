# Swarm MCP backpressure: first implementation increment

Design: https://github.com/MCPJam/mcpjam-backend/pull/1538

Preserve upstream throttle metadata before adding admission or tool retries. Keep
existing tool-call execution, authentication and protocol negotiation behavior.
Teach the existing wait parser to read the SDK error and fix `withRetry` so it
honors upstream waits above its computed-backoff cap, or declines retries whose
wait cannot fit the total budget. No production caller of `withRetry` was found
in this checkout; this increment does not wire it around MCP tool execution.
Shared admission placement is provisional: verify direct-manager and hosted-proxy
egress before choosing a coordinator or adding Convex calls per MCP request.

## TDD checklist

- [x] A tool-call 429/503 preserves the raw Retry-After header through the SDK
  transport, including both delta-seconds and HTTP-date values.
- [x] Missing/malformed headers do not invent a retry policy, and a rejected
  tool call is sent only once.
- [x] Successful results, auth handling and HTTP 400 protocol errors retain
  existing behavior.
- [x] The existing wait parser reads SDK error metadata, and the retry helper
  never retries before a valid server-requested wait.
- [x] Document direct and hosted egress coverage and remaining metadata gaps.

## Egress inventory (source inspection, not production verification)

| Path | Existing flow | Consequence for shared admission |
| --- | --- | --- |
| Synthetic session connection/discovery | `sessionSimulation/launch-journey-run.ts` → `routes/web/auth.ts:createAuthorizedManager` → manager `listTools` | Include initialization/discovery, not just `tools/call` |
| Host-executed harness tools | `utils/harness/host-executed-mcp-tools.ts` → manager `getToolsForAiSdk` | Explicitly bypasses the signed harness proxy |
| Native hosted harness MCP | `utils/harness/run-harness-turn.ts` → `routes/web/harness-mcp.ts` → authorized manager → `services/mcp-http-bridge.ts` | Observe upstream throttle before the bridge converts it to a generic RPC/tool error |
| Local harness | Tunnel → `routes/mcp/http-adapters.ts` → same bridge | Separate authorization context; excluded from the initial hosted pilot |

All inspector paths above are relative to `server/`. Direct and hosted HTTP
managers use `sdk/src/mcp-client-manager/MCPClientManager.ts:buildTransportFetch`.
That method already accepts a per-server `baseFetch`, below logging/routing
wrappers, for both Streamable HTTP and legacy SSE. Reuse this seam for authorized
admission plus raw-response observations; do not invent a second SDK hook or
count the same request at the proxy and manager.

The metadata change here is narrower: it preserves `data.retryAfter` only where
`http-error-fetch.ts` already wraps Streamable HTTP tool-call errors. It does not
change initialize/list responses, legacy SSE, auth retries, HTTP 400 protocol
errors, or propagate metadata through the harness-facing RPC envelope. Future
admission must observe these responses at `baseFetch` rather than assume this
tool-error wrapper covers them. STDIO has no HTTP Retry-After. Separate proxy
deployments, redirects and provider-internal subrequests still require inspection.

Recommendation: enforce in a per-server fetch wrapper installed by authorized
manager construction, with one shared coordinator across worker replicas. Convex
remains one candidate coordinator; measure latency/cost before choosing it.

## TDD evidence

1. Six SDK transport cases failed on missing `retryAfter`; all passed after
   preserving only that header in `SdkHttpError.data`.
2. Four parser/classification cases failed on lost waits; all passed after
   reusing the existing seconds/date parser for the SDK metadata shape.
3. Four retry cases failed because a five-second wait became one second, or a
   ten-minute wait triggered a retry despite a ten-second budget. They pass after
   removing the upper clamp on upstream waits. Computed exponential backoff
   retains its existing cap; cancellation and total-budget guards remain active.

No shared pacing, cooldown enforcement or automatic tool-call replay is enabled
by this increment. Screenshots and recording remain pending; a metadata-only
change has no new user-visible flow, so an explicit exception is required before
requesting review of this increment without visual evidence.
