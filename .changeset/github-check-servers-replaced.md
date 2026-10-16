---
"@mcpjam/inspector": patch
---

A GitHub check run no longer fails when its environment's server group still names a deleted server. The check replaces every server with the PR's own, so that server is never used.
