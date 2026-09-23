---
"@mcpjam/inspector": patch
---

A judge-graded run no longer loses the expected-tool-calls score for cases written as steps. The judge's second pass now reads the case the way the runner does, so the tool-call row keeps its definition and score integrity stays valid.
