---
"@mcpjam/cli": minor
---

Add `mcpjam projects` commands for hosted MCPJam projects: `projects list`, `projects servers --project <id-or-name>`, and `projects status --project <id-or-name>` (per-server hosted health checks via the shared `show_servers` operation). JSON output is the operation payload verbatim; human output renders tables and a status summary. Auth via `--api-key` / `MCPJAM_API_KEY` / `mcpjam login`.
