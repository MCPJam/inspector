---
"@mcpjam/inspector": minor
"@mcpjam/sdk": patch
---

Add Quality gate rows and a reachable review/save reason

The Grading tab could describe a verdict policy but not the stored suite
quality gate B2 now writes. Baseline, allowed drop, deterministic
regressions, p95 growth, and the independent gating-scorer-error switch
draft through the existing commit bar. A quality-gate change asks for a
reason in the review dialog without locking Review and save. Older
backends keep an unsaved policy instead of claiming it saved.
