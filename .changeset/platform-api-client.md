---
"@mcpjam/sdk": minor
---

Add `@mcpjam/sdk/platform`: a runtime-agnostic (Workers/browser/Node) fetch-based client for the MCPJam Platform API (`/api/v1`) plus a curated operation catalog — `list_projects`, `list_project_servers`, and `show_servers` (project resolution, one hosted-doctor call per server, stable `ShowServersPayload`). Errors surface as `PlatformApiError` with the stable v1 wire code, HTTP status, details, and `Retry-After` capture.
