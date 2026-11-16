---
"@mcpjam/inspector": patch
---

Harness clients with tool approval on now run in evals, swarms and the v1 chat API instead of being refused. Evals run their tools with approval off and record how many calls would have asked for it. Swarms deny each call that needs approval with the same result MCPJam's own agent gives, and the session continues. The v1 API leaves approval off. Playground and User Testing still pause for the person.
