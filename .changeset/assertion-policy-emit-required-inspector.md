---
"@mcpjam/inspector": patch
---

The hosted runner and the settings UI now author `role: "required"`, the canonical spelling, and read both spellings everywhere a stored role reaches them.

Reading both is the load-bearing half. The backend stamps `metadata.judgeVerdict.role` as `"gating"` on every verdict written before the rename and `"required"` after it, and four places compared that field against one literal: the hosted judge's score row, the second-pass definition projection, `judgeMode` on the suite settings page, and the case scorecard's judge answer. Each was fail-closed, so each would have silently read a required judge as advisory — un-gating it — for runs on one side of that line.

`--no-gating-score-errors` keeps its name: it is a published CI contract and it names the quality gate, not an assertion's policy. Its help text, and the quality-gate section's copy, now say "required".
