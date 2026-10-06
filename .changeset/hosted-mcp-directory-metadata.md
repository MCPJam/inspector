---
"@mcpjam/sdk": patch
"@mcpjam/cli": patch
"@mcpjam/inspector": patch
---

Platform operation descriptions state facts instead of instructions. They no longer tell an agent where to start, what to check first, or to fetch a skill, and they no longer name tools or CLI commands an MCP client cannot reach. Several descriptions are corrected: `publish_study` creates a new study on every call (it is not idempotent), `get_capabilities` reports only the Swarms feature flag among betas, `update_project` can remove access when it makes a project private, and the judge and insight requests overwrite stored results when forced. `create_project_server`, `update_project_server`, `connect_project_server` and `call_server_tool` now link the API or MCP specification they follow.
