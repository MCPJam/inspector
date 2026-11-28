---
"@mcpjam/sdk": patch
"@mcpjam/inspector": patch
---

The MCP Apps host bridge now answers `ui/open-link` and `ui/download-file` with `{ isError: true }` when the host passes no callback to open the link or save the file, instead of reporting success. The eval run page passes neither, so an app in an eval or goal run is no longer told its link opened or its download saved when nothing happened.
