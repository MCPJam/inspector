---
"@mcpjam/cli": patch
---

Hosted eval commands now allow 120s per request instead of inheriting the 30s default meant for a local MCP probe. Syncing a suite file is several round trips bounded by the server under test, and it was timing out in CI on the workflow the docs teach. An explicit `--timeout` still wins.
