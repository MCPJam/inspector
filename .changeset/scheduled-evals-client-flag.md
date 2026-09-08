---
"@mcpjam/inspector": patch
---

Schedule gets its own feature flag, so it can stay dark while it is tested

**It was sharing `synthetic-monitors` with the monitor scorer kinds, so hiding one meant hiding the other.** The Triggers tab's "Scheduled runs" row and the Monitoring rail item a scheduled suite earns now answer to `scheduled-evals-enabled`, which starts off for everyone. `synthetic-monitors` keeps gating the scorer kinds, their menus, and the widget-probe half of the Monitoring rail — the two halves ship on different clocks. With Schedule hidden the Triggers tab shows GitHub Checks alone and drops its right rail, since a one-entry subsection nav renders nothing.
