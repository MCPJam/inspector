---
"@mcpjam/cli": patch
---

`cloud projects servers connect` prints the handoff link only once the request waits on a person, says when the project will be chosen in the browser and how `--project` skips that, and exits 1 when the request ends failed, expired, or cancelled, or connects a server that is disabled. A malformed flag such as a non-http(s) `--url` is now a usage error (exit 2).
