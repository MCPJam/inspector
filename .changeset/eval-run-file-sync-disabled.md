---
"@mcpjam/cli": patch
---

`eval run --file` now creates and updates `disabled: true` cases so the hosted suite matches the file. Those cases stay out of the launch; only a case the file no longer declares is deleted.
