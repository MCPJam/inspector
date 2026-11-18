---
"@mcpjam/sdk": minor
"@mcpjam/cli": patch
"@mcpjam/inspector": patch
---

A run stopped by MCPJam credits now says how to recover. Credit refusals carry a structured `recovery` (what to do, who does it, and the link), and every surface leads with the same sentence built from it: the run's notes, each skipped trial, the decision summary's next action, the error describer's first step, and a new `Recovery:` line in `mcpjam cloud eval status` and `eval run --wait`. Before, the notes and skipped trials said "add credits or upgrade" with no link whatever the plan or role, and the next action pointed at the run notes. `get_eval_run` and the CLI's JSON carry the field as `creditRecovery`; an iteration's `infraError` carries it as `recovery`, and a launch the platform fee refuses as `details.recovery`. A swarm attempt's error no longer reads "keep going: BYOK …" once its link is stripped. A refusal from a deployment that sends no `recovery` keeps the old text. `parseCreditRecovery`, `formatCreditRecovery`, `creditRecoveryOfRefusal`, `creditRecoveryOfIterations` and `readEvalRunCreditRecovery` are exported from `@mcpjam/sdk`. Exit codes are unchanged.
