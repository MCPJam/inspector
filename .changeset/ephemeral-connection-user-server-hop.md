---
"@mcpjam/inspector": patch
---

Declare the user-server hop on the hosted ephemeral connection.

`withEphemeralConnection` is the highest-traffic error path in the server —
`/api/web/tools/list` and `/api/web/servers/validate` alone produced 2,266 of
2,851 prod `http.request.failed` rows in 7 days — and its catch declared
nothing about which hop failed, so every one of those rows was unattributed.

The declaration is a span, not a whole-route flag, and the distinction is the
whole point. Everything before the manager op is MCPJam's hop:
`getConvexBearerForRequest`, `fetchScenarioRuntimeConfig` and
`createAuthorizedManager` all reach our own Convex deployment. Marking the
entire catch would stop paging us during a Convex outage and simultaneously
tell the user their MCP server was down — strictly worse than the noise it
would fix. `createAuthorizedManager` returns without awaiting its connects (the
constructor queues them as microtasks), so the first thing that actually
touches the user's server is the manager op inside `fn`, which makes that the
narrowest span still catching connect failures.

`runEphemeralConnection` marks failures from that span with the existing
`markUserServerHop`, and the route catch reads the mark to record
`hop: "user_server_hop"`. Anything reaching the catch unmarked — a malformed
body, an authorize failure, our own Convex refusing — stays unattributed,
because absent means unknown and never "the user's".

Attribution only: no status changes. Answering 424 for an unreachable target,
as `chat-v2` already does, goes through `namesAnMcpServer` and needs the server
name threaded to the catch rather than recovered from the message. That is the
one user-visible change in this program and it ships separately.
