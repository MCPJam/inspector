---
"@mcpjam/inspector": patch
---

Enabling a suite schedule needs a deployment switch, on every agent-facing writer

**Hiding the row stopped the screen, not the API: the schedule PATCH was reachable by any key holder.** `MCPJAM_SCHEDULED_EVALS_WRITE_ENABLED` (default off) gates `PATCH /v1/projects/:p/eval-suites/:id/schedule` when the body enables a schedule — answering 404, so a deployment with the feature off does not advertise it. One guard covers the SDK client, the `set_eval_suite_schedule` MCP tool, `mcpjam cloud eval schedule` and proposal execution, since all four self-dispatch through `/api/v1`. The same op is withheld from the agent's tool set and its approved-action execute path while the switch is off.

Disabling a schedule stays ungated **on the route**: a gate that strands a schedule already firing, with no way to switch it off, is the worse failure. The agent surface is stricter — the policy set gates by operation name and cannot read an argument, so while the switch is off the agent loses disable as well as enable. A person can still disable one through the API or the CLI.
