---
"@mcpjam/inspector": patch
---

Credit refusals across the Inspector now tell an agent or user the one action that recovers — upgrade on Free, buy credits on paid — with the exact link, and never steer toward waiting or BYOK. Chat, web search, and the swarm session card render the backend's structured `recovery`; the swarm attempt error carries it as a field so the link survives its prose scrubber. A credit refusal with a non-wait recovery is never auto-retried on a timer, and a `retryAfter` of 0 can no longer form a hot retry loop.
