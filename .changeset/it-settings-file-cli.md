---
"@mcpjam/cli": minor
---

Honor the IT settings file the SDK reads. With `"lock": true`, `--api-url`, `MCPJAM_API_URL`, `MCPJAM_BASE_URL` or `compat --catalog-url` naming another server exits `2` (`DEPLOYMENT_LOCKED`) before any request, a saved login for another server exits `3`, and telemetry and the update check are off. With `"lock": false` the file is the organization default. An invalid file stops every command that would contact MCPJam with exit `2` (`MANAGED_SETTINGS_INVALID`) and turns telemetry and the update check off; other commands still run.

- `mcpjam cloud status` describes where the server came from, including `set by your organization (locked)`, and the audience line names an organization's server.
- `compat` reads the host catalog from the resolved server. An unparsable `--catalog-url` is now a usage error.
- The legacy `mcpjam_` key message links to the API keys page of the server the command uses.
