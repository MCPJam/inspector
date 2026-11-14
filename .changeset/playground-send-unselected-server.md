---
"@mcpjam/inspector": patch
---

A server that failed to connect no longer stops the Playground from sending when it isn't one of the servers added to the Playground. It used to refuse every message with "Couldn't connect to" that server.
