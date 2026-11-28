---
"@mcpjam/inspector": patch
---

Run each eval at the grading mode its suite is saved with. The Inspector used to cap it with the `MCPJAM_GRADING_ENGINE_MODE` environment variable, which reads as off when unset, so runs from the npm package and the desktop app never wrote scorecard rows. The variable no longer has any effect.
