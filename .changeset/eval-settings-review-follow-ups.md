---
"@mcpjam/inspector": patch
---

Eval settings: the review follow-ups

**A reviewer label could land on the wrong trial.** The trial review panel kept the previous trial's label on screen while the next one loaded, and a label clicked before the first read finished counted as a fresh blind label. The panel is now scoped to the trial it shows, renders a neutral placeholder until its read lands, and never mounts on a quick-run trial that has no run to review. On a run judged with trial keys, a trial with no verdict of its own no longer borrows a sibling repetition's.

**Backtest and "Compare with run" picked the oldest run.** Both now take the newest, and a run whose judge never stored a verdict is not offered for backtest.

**The gate switch could not be lowered once stale.** A judge already set to gate whose calibration lapsed left the switch disabled while on. It can always be turned off; only turning it on waits for calibration.

**The pass threshold field saved 0 when blanked, committed on Escape, and drifted on a no-edit blur.** A blank reverts, Escape reverts, and a stored 85.5% shown as 86 stays 85.5% until somebody types.

**Revision history labels come from the settings manifest**, so a rename propagates, and an edit by someone who has left the organization reads "A former member" rather than "System".

**A held run's rail and mini-bar are amber**, matching its badge, in the runs list and run overview. The judge's agreement line shows the chance-corrected figure when the backend reports one.
