---
"@mcpjam/inspector": patch
"@mcpjam/sdk": patch
---

Codex hosts can now run at a reasoning effort. Both Codex transports apply low, medium, high and xhigh through their own runtime option (exec `reasoningEffort`; app-server `turn/start` effort), so a Codex host with a saved effort runs instead of being refused. The turn's effort also rides the harness model-broker lease start so the backend can verify what reaches the wire. Claude Code carries the mapping code (`effort` option, adaptive thinking, the effort env instead of `unset`) but stays inert and still refuses an effort until it is verified live. Organization cloud connections no longer refuse an effort in the inspector; the backend applies it per provider, and the SDK offers it for the same provider families as a direct call.
