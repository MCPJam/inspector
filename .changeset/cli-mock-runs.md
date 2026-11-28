---
"@mcpjam/cli": minor
---

Adds `mcpjam cloud mocks run open`, `run reset` and `run close` for a mock's test runs, and `--operation-key <key>` on `tools call`, which makes a write to a mock's records safe to retry: the same key with the same call writes once and returns the first outcome.
