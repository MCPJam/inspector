---
"@mcpjam/inspector": patch
---

New eval suites are created as environment suites in one call.

- On a backend that supports it (`createSuiteWithEnvironments`), the create-suite page and dialog create the suite with its environments in one call, so no legacy client is attached first. The Excalidraw quickstart and prepared evals do the same: one environment per picked client, with its server group.
- Older backends keep the previous two-call path.
- Suites authored on the server (inline eval runs and `POST /v1/.../eval-suites`) are created as environment suites when the request pins one environment: its servers by id, at most one client and at most one model. Anything else keeps the legacy create.
