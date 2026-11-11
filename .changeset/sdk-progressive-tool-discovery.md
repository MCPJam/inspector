---
"@mcpjam/sdk": minor
---

`HostRunner`, `EvalSuite.runWithClient` and `mcpjam test --host` now apply a host's Progressive tools setting the way hosted runs do. On starts the model with `search_mcp_tools` and `load_mcp_tools` and loads only the tools it needs. A saved client or host template left on Auto (unset) does the same once it has 30 tools or about 10k tokens of tool definitions; a host built in code that leaves the setting unset still sends every tool. Off sends every tool. `runWithClient` no longer refuses clients set to On. While discovery is on, a call to a tool the model has not loaded never runs and is left out of `toolsCalled()`. Before this, `HostRunner` sent every tool even when the setting was on, while results reported discovery as enabled.
