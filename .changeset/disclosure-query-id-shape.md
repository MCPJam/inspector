---
"@mcpjam/inspector": patch
---

The pre-run disclosure route answers 404 when `caseIds`, `environmentId`, `environmentIds` or `host` is not a platform id, such as a case's `declaredId`. It used to forward the value to Convex and answer 502.
