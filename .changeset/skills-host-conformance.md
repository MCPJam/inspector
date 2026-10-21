---
"@mcpjam/inspector": patch
"@mcpjam/sdk": patch
---

Bring the host side of Skills over MCP in line with the stable spec: `bash` and `read_server_resource` always ask while a server-provided skill is loaded, and an org provider on the local runtime, which cannot resume after an approval, refuses such a turn; file reads are held to the manifest the skill was loaded under, read only from the load that wrote it; captured server skills carry the origin banner and are re-checked against their stored digest; verification uses the spec's 16 MiB budget while one tool result is capped at 256 KiB; a URI two servers serve resolves with the `server` hint; a colliding captured ref is disambiguated instead of dropped; relative references resolve like paths; verified reads are cached in memory per manager and dropped when the server is removed.
