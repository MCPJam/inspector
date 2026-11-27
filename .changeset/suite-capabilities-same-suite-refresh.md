---
"@mcpjam/inspector": patch
---

Eval suite settings keep showing the suite's capabilities while a newer revision's are fetched, instead of dropping to a loading state, so an open editor stays put after a save. The backend still validates every save against the current capabilities.
