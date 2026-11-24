---
"@mcpjam/cli": minor
---

New `mcpjam cloud mocks create`, `update` and `get` for mock servers: a saved server (or nothing) with a definition that changes only what it states. `update` takes a whole definition or a JSON merge patch with `--expected-version`, and `--dry-run` prints the change list without saving.
