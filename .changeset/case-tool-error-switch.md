---
"@mcpjam/inspector": patch
---

An eval case now has a "Fail this case when a tool call returns an error" switch below Expected outcome. It is on by default. Turn it off and a tool error the model recovers from no longer fails the case on its own: the case's other evaluators decide, and the error still shows in the trace. A turn that never finishes still fails either way.
