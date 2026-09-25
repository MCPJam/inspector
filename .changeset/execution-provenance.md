---
"@mcpjam/sdk": patch
"@mcpjam/cli": patch
"@mcpjam/inspector": patch
---

Show what each result actually ran on.

The SDK adds `readExecutionRecord` and `formatExecutionProvenanceLine` (with `summarizeExecutionRecord` and friends) for the backend's execution record, `PlatformEvalIteration.execution`, the run disclosure's per-model `provenance` / `recorded` facts, and an error slug `provider/fallback_prohibited`. Eval iterations (and their scorecard), swarm sessions and chat turns show "Ran on <model> via <rail/connection>, <harness vX>, effort/temperature, max output" with a visible deviation banner, and `mcpjam eval run --wait` prints the same line per iteration. Rows recorded before the record existed show nothing, or "not recorded" in the CLI; nothing is guessed.
