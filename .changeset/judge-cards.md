---
"@mcpjam/inspector": minor
"@mcpjam/sdk": patch
---

Show goal-completion and groundedness as shared suite judge cards

C1 now advertises a reserved groundedness slot. Settings keeps one card
layout for both judges: goal completion still authors model, threshold,
rubric, agreement, and the gate, and offers Warn only when that capability
is present. Groundedness shows stored run evidence or an honest not-yet-run
state, with no configuration controls. PATCH accepts goal-completion
severity, preserves a stored groundedness slot, and refuses a groundedness
write while execution is unwired.
