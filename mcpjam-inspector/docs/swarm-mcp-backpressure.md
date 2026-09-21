# Swarm MCP backpressure: hosted pilot

Design: https://github.com/MCPJam/mcpjam-backend/pull/1538

The hosted pilot now installs a per-server admission fetch wrapper before manager
construction. It reuses the existing pinned fetch, cancellation/deadline helpers,
Retry-After parser and Convex rate-limiter component. It is off by default; enroll
connection ids with `MCPJAM_MCP_BACKPRESSURE_SERVER_IDS` only after backend rollout.

The backend design above is the policy reference. Two starts/second (burst two),
shared monotonic cooldowns, a 60-second admission budget per POST and 64 pending
requests per connection/process bound the pilot. Static/shared OAuth connections
share across users; personal OAuth uses separate connection buckets; XAA uses user buckets. It does not add
automatic tool replay or a distributed in-flight cap.

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
errors, or propagate metadata through the harness-facing RPC envelope. The new admission wrapper observes these responses at `baseFetch`; it does not
rely on the narrower tool-error metadata wrapper. STDIO has no HTTP Retry-After. Separate proxy
deployments, redirects and provider-internal subrequests still require inspection.

Admission is installed for hosted project-member HTTP managers, covering all three
listed hosted paths by construction, including initialization/discovery. Local,
shared-chat and STDIO paths are excluded. GET listening, DELETE and cancellation
notifications bypass pacing. Coordinator failures stop dispatch. Feedback failure
replaces the upstream response with an admission error and stops that wrapper.
No new waiting UI or outcome taxonomy is added. Deployed path verification and
latency/cost measurement remain rollout gates.

## TDD evidence

1. Six SDK transport cases failed on missing `retryAfter`; all passed after
   preserving only that header in `SdkHttpError.data`.
2. Four parser/classification cases failed on lost waits; all passed after
   reusing the existing seconds/date parser for the SDK metadata shape.
3. Four retry cases failed because a five-second wait became one second, or a
   ten-minute wait triggered a retry despite a ten-second budget. They pass after
   removing the upper clamp on upstream waits. Computed exponential backoff
   retains its existing cap; cancellation and total-budget guards remain active.

4. The new admission suite failed against an unimplemented wrapper, then passed
   after adding shared decisions, feedback, cancellation, queue guards and budgets.
   A cancellation test also caught a busy loop in abort-resolving sleep; the loop
   now checks the signal before each sleep.

Validation for this increment: 143 admission/auth/supervisor tests and 110 swarm
runner/sandbox tests pass. Backend 44 focused tests and real local curl checks
cover shared pacing, monotonic cooldowns, auth and resumption. Earlier SDK metadata
increment had 94 passing transport/retry/manager tests. Full repository check
limitations are recorded in the draft PRs.

No production rollout. Screenshots and a recording remain pending. There is no
new UI, so an explicit nonvisual exception is needed before requesting review
without that media; keep the PR in draft while iterating.

## Multi-account integration after merging main

Each expanded manager entry retains its real server id and selected credential id
when installing admission. The default and non-default entries are both protected;
synthetic manager keys never become coordinator server ids. Explicit single-account
selection is also forwarded. Deploy backend follow-up
[#1539](https://github.com/MCPJam/mcpjam-backend/pull/1539) before enrolling these
paths so connection ownership is validated and unrelated personal accounts remain
independent. Shared auto-discovered OAuth remains shared across project members.
