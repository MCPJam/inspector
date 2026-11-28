---
"@mcpjam/inspector": patch
---

A local Inspector can now say, before a run, where an eval with a harness client runs: `GET /api/mcp/local-harness/eval-venue` answers on this machine, in the cloud, or not here with the reason and the one fix. A suite run the backend refuses for its code evaluators or scripts now returns that refusal as a 400 with its text, instead of a 500. A single test case with a tool policy says why its harness can't run here before refusing the policy. Codex's setup copy no longer says evals run in the cloud on other machines, and an old Git version's refusal says what to do.
