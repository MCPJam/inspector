---
"@mcpjam/inspector": patch
---

A configured shutdown drain also waits for swarm runs and for the work a backend doorbell started. While draining, a new swarm launch is refused with a retryable `429` (`SERVER_DRAINING`) and a doorbell ring with a `503`, which the backend re-delivers.
