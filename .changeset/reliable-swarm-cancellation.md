---
"@mcpjam/sdk": patch
"@mcpjam/inspector": patch
---

Support durable swarm Stop requests. Runners poll every five seconds and abort active work when cancellation is reported. Show Stop requested during background cleanup and Stopped after settlement, including after refresh. Expose optional cancellation and cleanup fields through goal and legacy journey APIs and SDK types.
