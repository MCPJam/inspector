---
"@mcpjam/inspector": patch
---

The browser panel now opens when the model calls one of a page's own tools (`webmcp_*`), `browser_webmcp_tools` or `browser_webmcp_invoke`, as it already did for the other browser tools. Its list now comes from the tool names the server builds, so it no longer names two tools that don't exist.
