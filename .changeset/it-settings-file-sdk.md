---
"@mcpjam/sdk": minor
---

Read an IT settings file that sets, and can lock, the MCPJam server for every Node entry point: `/Library/Application Support/MCPJam/managed-settings.json` on macOS, `/etc/mcpjam/managed-settings.json` on Linux, `C:\Program Files\MCPJam\managed-settings.json` on Windows, with `{ "version": 1, "apiUrl": "https://…/api/v1", "lock": true }`. No environment variable moves the file.

- `"lock": true` makes its server the only one: an explicit `baseUrl` or a variable naming another server throws `DEPLOYMENT_LOCKED` before any request, and the SDK's PostHog and Sentry are off.
- `"lock": false` makes it the organization default, below explicit options, the variables and the saved login.
- A file the SDK cannot enforce exactly (bad JSON, a missing or mistyped field, an unknown key, plain `http://` to a non-loopback host) throws `MANAGED_SETTINGS_INVALID` from everything that would contact MCPJam, and turns telemetry off.
- `createModelFromString` from `@mcpjam/sdk` honors the file for `mcpjam/…` models; `@mcpjam/sdk/model-factory` imported alone still reads only the environment. An eval run mints its model leases on the server it started on, and lease mint and revoke never follow a redirect.
