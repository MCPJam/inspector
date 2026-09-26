---
"@mcpjam/sdk": patch
"@mcpjam/cli": patch
"@mcpjam/inspector": patch
---

Eval surfaces stop creating environments without a server group.

An eval run takes its servers from the environment's server group alone, so an environment without one runs with no tools (the backend refuses it with `ENV_NO_SERVERS`).

- `compose.hostServers` (SDK/MCP) and `--compose-host-servers` (CLI) are rejected for eval runs with an error that names `server`/`servers`/`serverGroup` and `--compose-server`/`--compose-server-group`; their help text no longer describes following the client's list.
- The inspector's "Where it runs" gains a server-group picker. New clients and models take the picked group (never the suite's legacy `serverAttachmentId`), copy only a setup every candidate environment shares, and refuse rather than drop plugin pins, captured server skills or secret grants.
- The run dialog no longer composes environments from a suite's legacy fields, blocks Start for a target with no server group, and launches a suite without environments through its own configuration.
- The `/evals` create dialog seeds and requires a server group, like the create page.
