---
"@mcpjam/inspector": patch
---

Stop a hosted eval run when an iteration's sandbox is refused because the organization's free native harness turns are used up: the remaining iterations are skipped with that message instead of each failing at setup, and the refusal is no longer reported as an error.
