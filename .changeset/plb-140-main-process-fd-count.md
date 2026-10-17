---
"@mcpjam/inspector": patch
---

`process.vitals` now reports `openFdCount`, the server process's open file descriptors (`null` plus the errno in `openFdError` when the listing fails, e.g. on Windows), so a system-wide "Too many open files" crash can be told apart from an Inspector main-process leak.
