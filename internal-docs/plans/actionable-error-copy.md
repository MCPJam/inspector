# Actionable error copy

Improve confusing Inspector error messages where they are currently authored.
Each message should identify the user's blocked action and give a supported next
step, without exposing implementation vocabulary or promising that data is safe
unless the flow guarantees it.

Start with validation, save/load failures, and page recovery. Preserve conditions,
state transitions, recovery actions, and technical diagnostics. Review wording in
context and check existing behavioral tests. Keep this PR focused on copy edits;
centralization and OAuth persistence belong to separate work.

Track implemented wording changes, test evidence, and screenshots/recording in
the draft PR description. Do not claim app-wide coverage from a selective pass.
