---
"@mcpjam/sdk": patch
"@mcpjam/inspector": patch
---

Conformance: the OAuth "401 Unauthorized Received" step is now green only when the server really sent a 401. A 200 reports OAuth as not applicable, and a 403 challenge marks the step failed while the rest of the flow still runs.
