---
"@mcpjam/inspector": patch
---

Local and verbose server logs now end with the run, session, iteration, turn and request IDs from the log context, for example `runId=jx7d2k9 chatSessionId=synth_jx7d2k9_p1_0`. A swarm or eval run can now be followed in the terminal with telemetry off (`DO_NOT_TRACK=1`). No other context field is printed.
