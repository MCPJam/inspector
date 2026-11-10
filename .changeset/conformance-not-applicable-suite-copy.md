---
"@mcpjam/inspector": patch
---

A conformance suite that doesn't apply now reads the same on a live run and a saved one: "OAuth doesn't apply: this server needs no login." for a server that answered without a token, and "{Suite} doesn't apply to this server." otherwise. The run's score card no longer adds "OAuth not scored (no auth)", which only the live run showed.
