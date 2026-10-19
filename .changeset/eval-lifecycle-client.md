---
"@mcpjam/inspector": patch
---

Eval screens read when a run or iteration is finished from the SDK, so a timed-out run counts as finished everywhere. The findings panel no longer says iterations of a finished run are "still running", and iterations that never ran get their own label.
