---
"@mcpjam/inspector": patch
---

Stop reporting an unreachable target MCP server as an MCPJam outage.

`mapRuntimeError` classified every connection-class failure — the ECONN\* errno family, "fetch failed", "socket hang up", a refused or reset connection — as `502 SERVER_UNREACHABLE`. The code and the message were already right: the message says outright that this is a connection problem with the target server, not an MCPJam outage. The status contradicted both, and on hosted the status is the only part that survives.

Hosted traffic runs behind Cloudflare, which replaces an origin 5xx with its own branded error page. That discards the JSON envelope AND the `x-mcpjam-error-origin` header `webError` attaches for exactly this purpose. What reaches the browser is a Cloudflare HTML page with no verdict on it, so the chat client falls back to its documented rule — a 5xx from our own route is ours — and reports a user's own unreachable MCP server as an MCPJam failure. The user is told MCPJam was briefly unreachable when their server was the thing that refused, and the same event pages us.

The class is now `424 Failed Dependency`: the request was well-formed, and something it depends on failed. Any 4xx would have fixed the Cloudflare hop; 424 is the one that describes the situation honestly. A test pins the range rather than the digits, because the range is the load-bearing part — a later "more specific" 5xx would silently restore the old behavior.

Unchanged: the timeout branch still answers 504, upstream auth rejections still answer 401/403, and internal-boundary failures (a call to MCPJam's own Convex deployment) still answer 502 through their own call sites — those are ours, and they should keep paging us.
