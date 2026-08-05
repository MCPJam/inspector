---
"@mcpjam/sdk": minor
"@mcpjam/inspector": minor
---

Model ChatGPT's verified MCP and MCP Apps behavior in the built-in host profile.

The profile now records normal tool-call cancellation, MRTR modes, detailed CSP
probe results, resource-cache reuse, and container growth evidence. Unknown
ChatGPT results stay omitted, while the runtime applies the verified
cancellation and MRTR behavior.
