---
"@mcpjam/cli": minor
---

Reach the operations that had a route and an SDK binding but no command.

The CLI was the only operation surface with no drift check, and three operations had quietly become shell-unreachable — most painfully `list_eval_suite_runs`, so a CI job could start a run but not list what had already run.

- `mcpjam eval runs --suite <suite>` — a suite's run history.
- `mcpjam chatboxes list | get` and `mcpjam chat-sessions list` — reads only. Publishing, rotating a share link and managing members stay in the app, where the confirmation flows live.

`CLI_BINDINGS` now maps every operation to the command that exposes it or to a stated reason for having none, and its test walks each advertised path through the real Commander tree — so an entry naming a renamed or never-registered command fails rather than asserting coverage that doesn't exist. The 13 exclusions are one policy: the CLI talks to MCP servers directly (`--url` or a config file), so `tools call`, `prompts get`, `resources read`, `server doctor|validate|export` and `compat` keep working against a server that lives in no project and with no API key. Coverage goes from 47 to 60 of 73 operations bound.
