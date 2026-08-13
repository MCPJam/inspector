---
"@mcpjam/inspector": patch
---

Stop reporting an unreachable target MCP server as an MCPJam outage on hosted chat.

A connection-class failure — the ECONN\* errno family, "fetch failed", "socket hang up", a refused or reset connection — leaves `mapRuntimeError` as `502 SERVER_UNREACHABLE`. The code and the message were already right: the message says outright that this is a connection problem with the target server, not an MCPJam outage. The status contradicted both, and on hosted the status is the only part that survives.

Hosted traffic runs behind Cloudflare, which replaces an origin 5xx with its own branded error page. That discards the JSON envelope AND the `x-mcpjam-error-origin` header `webError` attaches for exactly this purpose. What reaches the browser is a Cloudflare HTML page with no verdict on it, so the chat client falls back to its documented rule — a 5xx from our own route is ours — and reports a user's own unreachable MCP server as an MCPJam failure. The user is told MCPJam was briefly unreachable when their server was the thing that refused, and the same event pages us.

`/api/web/chat-v2` now maps that class through `mapTargetServerError`, which answers `424 Failed Dependency`: the request was well-formed, and something it depends on failed. Any 4xx would have cleared the edge; 424 is the one that describes it honestly. The status is mutated on the already-mapped error rather than rebuilt, so `origin`, `normalized` and the capture-dedupe cause link all survive — `origin` is what the header carries.

Deliberately a separate entry point rather than a change to `mapRuntimeError`. That mapper is a shared envelope with no hop information: the same branch catches a failed fetch to MCPJam's own Convex deployment (`/api/web/server-secrets` reaches nothing else) and the router-wide `web.onError`. Downgrading those would stop paging us during our OWN outage, which is strictly worse than the problem being fixed — so the status now follows the rule the origin already does, and the catch site that knows the hop declares it. A pre-built `WebRouteError` is passed through untouched for the same reason: a deliberate 502 is how a caller says its hop was internal.

`requestLogContextMiddleware` now treats 424 as a failure alongside the 5xx range. Without that, moving these failures out of 5xx would also move them out of `http.request.failed` and lose the `errorCode`/`origin`/`slug` breakdown — the Axiom slice that makes an unpaged `ambiguous` bucket measurable, and therefore promotable later as a data decision rather than a guess.

Unchanged: timeouts still answer 504 (and still take precedence over the connection branch), upstream auth rejections still answer 401/403, and every other route still answers 502 for an unreachable dependency.
