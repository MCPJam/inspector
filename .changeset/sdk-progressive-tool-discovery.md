---
"@mcpjam/sdk": minor
---

`HostRunner`, `EvalSuite.runWithClient` and `mcpjam test --host` now apply a host's Progressive tools setting the way hosted runs do. On starts the model with `search_mcp_tools` and `load_mcp_tools` and loads only the tools it needs; unset (Auto) does the same once a host has 30 tools or about 10k tokens of tool definitions; Off sends every tool. `runWithClient` no longer refuses clients set to On. A host built in code that leaves the setting unset and has 30 or more tools now uses discovery; set `progressiveToolDiscovery: false` to keep sending every tool. Before this, `HostRunner` sent every tool even when the setting was on, while results reported discovery as enabled.
