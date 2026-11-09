---
"@mcpjam/inspector": patch
---

The conformance run timeout moves from the run setup to a server's Conformance Settings, as its own "Run Timeout" section that saves like the rest of Settings. Runs on a server that is not saved in the project, or with no project, use the default 300 seconds.
