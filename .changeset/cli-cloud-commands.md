---
"@mcpjam/cli": minor
---

Add `mcpjam cloud` commands for hosted MCPJam projects: `cloud projects list`, `cloud servers list --project <id-or-name>`, and `cloud servers status --project <id-or-name>` (per-server hosted health checks via the shared `show_servers` operation). JSON output is the operation payload verbatim; human output renders tables and a status summary. Auth via `--api-key` / `MCPJAM_API_KEY` / `mcpjam login`.
