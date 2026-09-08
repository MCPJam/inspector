---
"@mcpjam/inspector": patch
---

Pin the synthetic-monitor completion payload to the shape the backend accepts. The advisory-failure test asserted a `role` field that `criterionResultValidator` — a closed Convex object — refuses, so a rubric carrying a Warn criterion would have 500'd on every completion and re-entered the lease/retry loop. The test now proves the wire contract instead of a field that could never travel.
