---
"@mcpjam/inspector": patch
"@mcpjam/sdk": patch
---

Bring the host side of Skills over MCP in line with the stable spec: `bash` and `read_server_resource` always ask while a server-provided skill is loaded; file reads are held to the manifest the skill was loaded under; captured server skills carry the origin banner and are re-checked against their stored digest; a skill up to the spec's 16 MiB budget loads; a URI two servers serve resolves with the `server` hint; a colliding captured ref is disambiguated instead of dropped; relative references resolve like paths; and verified reads are cached in memory per manager.
