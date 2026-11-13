---
"@mcpjam/inspector": patch
---

A hosted readiness run that opted into model observations asks MCPJam to draft arguments for the cases in its test plan that have none, up to 24 a run, before it tests any tool. Its report lists each drafted case's arguments, expected refusal and rationale, the cases left undrafted and why, and how many drafts MCPJam's checks dropped. The run never sends a draft and never changes the saved plan: a person accepts drafts into a new plan revision.
