---
"@mcpjam/sdk": minor
"@mcpjam/inspector": patch
---

Warn/Report (advisory) checks never halt or fail a trial

A check marked `role: "advisory"` (and `severity: "warn"`) is still evaluated
and still written as a score row, but it is excluded from every verdict
reduction — SDK, hosted iteration, step fail-fast, stage derivation, and
synthetic-monitor paging. Criterion identity is unchanged: adding policy
fields does not rename a scorer.
