---
"@mcpjam/inspector": minor
---

Add the HOSTED `subscriptions/listen` passthrough route (MCP 2026-07-28 §13.4).

`POST /api/web/subscriptions/listen` authorizes + connects a server exactly like an ordinary hosted op, opens a dedicated official-client connection, and drives the era-neutral `SubscriptionCoordinator`. Acknowledgement, notifications, lifecycle status, and safe errors are forwarded downstream over SSE.

- The downstream browser stream and the upstream MCP subscription stay on the same replica for their shared lifetime — no notification is written to Convex to cross replicas (horizontally scalable by construction).
- Browser abort cancels the upstream listen and disposes the manager in `finally`; upstream graceful vs remote closure is a distinct structured terminal event; the coordinator runs with `maxAttempts: 0` so a remote loss closes downstream and the browser re-opens from the desired filter (no replay).
- A keepalive comment frame defeats idle proxy teardown; a per-actor concurrent-stream cap protects the replica; stream duration + close reason go to Axiom and payload-free feature usage to PostHog.

Merge-blocked pending the §13.4 hosted-infrastructure investigation gate (LB idle limits, sticky duration, reconnect-after-replica-restart).
