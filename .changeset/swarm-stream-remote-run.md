---
"@mcpjam/inspector": patch
---

Keep a running swarm's live view open when its runner is on another server: the stream no longer reports the run as complete until the backend has settled it, and reconnects a few times to reach the server running it.
