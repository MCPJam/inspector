---
"@mcpjam/sdk": patch
---

`diagnose_server` returns a diagnosis instead of failing when hosted MCPJam won't connect to a saved server: a plain `http://` URL, a stdio command, or no URL. The report fails the connection check, gives the reason and the next step, and skips the other checks. The descriptions of `list_server_tools`, `call_server_tool` and `list_server_resources` now say that a saved server's tools, such as a documentation server's search, are how it does work, and that `call_server_tool` runs one.
