---
"@mcpjam/inspector": patch
---

Key hosted-turn failure classification on the turn outcome record's lifecycle rather than on the absence of a turn trace. Trace absence only ever marked a failure because a turn that ended badly was excluded from persistence; with failed turns recorded, absence stops marking them and a cancelled turn — which is not a failure — starts looking like one. Evals and swarms now read the record first and fall back to the old heuristics only when no record exists.

Swarm runs also check cancellation explicitly, so a stopped hosted turn returns the input history unchanged instead of being reported as a failed reply.
