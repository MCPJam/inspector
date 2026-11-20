---
"@mcpjam/inspector": minor
---

Behind the evaluator library flag, suites can add code evaluators: TypeScript `evaluate(run)` functions that grade every trial in an E2B sandbox with no network and a 10-second limit, as Required or Advisory. A throw, timeout or bad return value is an error, never a fail. Two starters open as editable copies, and "Test on a past run" runs a draft on one stored trial.
