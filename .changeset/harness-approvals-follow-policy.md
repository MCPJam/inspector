---
"@mcpjam/inspector": patch
---

Harness clients with tool approval on now run in evals, swarms and the v1 chat API instead of being refused. Evals run their tools with approval off and record how many calls would have asked for it. Swarms deny each call that needs approval with the same result MCPJam's own agent gives, and the session continues. The v1 API leaves approval off. Playground and User Testing still pause for the person.

The v1 chat API's default `toolMode: "read_only"` now runs on harness clients instead of being refused: a call to an MCP tool not annotated `readOnlyHint: true` is refused where it runs, through MCPJam's proxy or as an MCPJam-run tool. The client's own built-in tools, such as its shell, are not narrowed.
