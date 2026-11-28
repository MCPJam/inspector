---
"@mcpjam/sdk": minor
---

`patch_mock_server` sets or removes exactly one path of a mock against `expectedVersion`, and `refresh_mock_server` previews the real server's changes and the overrides they break, and saves them when `apply` is set. A mock whose override no longer fits the real server answers with the override's path (`findBindingIssues`, `applyFieldEdit`).
