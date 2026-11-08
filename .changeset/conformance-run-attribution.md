---
"@mcpjam/sdk": patch
"@mcpjam/inspector": patch
---

A hosted conformance run records which client started it. `startConformanceRun` sends the same launch headers an eval launch does, and a run read over `/api/v1` returns `launcher`, `attribution` (the surface the server verified, and the API key) and `settingsSource`. Requires a backend that stores them.
