---
"@mcpjam/inspector": patch
---

User Testing: a study with no tester sessions now opens on Insights instead of Findings. Findings summarises what testers did, so on a brand-new study — the first thing anyone sees after creating one — it rendered as an empty frame that read like a broken page. Studies that have sessions still land on Findings, and an unreported session count is treated as unknown rather than zero. Explicit `?tab=` links are unchanged and still win over the landing tab.
