---
"@mcpjam/sdk": minor
---

Add an opt-in anonymous protected-tool probe. It makes at most two tool calls and requires readOnlyHint; this annotation is supplied by the server and is not a security guarantee. Run probes only against trusted test servers because calls use empty inputs and can execute.
