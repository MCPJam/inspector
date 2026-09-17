---
"@mcpjam/sdk": minor
"@mcpjam/inspector": minor
---

Drop the goal-completion judge's two operator deployment controls. Grading is on by default and is turned off through a suite's own judge settings, which every caller can already read and write.

`GoalJudgePolicy` no longer reports `executionPaused`, the resolved judge on a suite response no longer carries that field, and `judge_execution_paused` leaves the judge error code contract. Both were produced only by backend environment variables that were never set on any deployment, so no stored verdict or suite carries either value. Readers that treated the field as optional need no change.
