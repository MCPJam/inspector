---
"@mcpjam/inspector": patch
---

`process.vitals` now reports `openFdCount` on hosted servers (`null` plus the errno in `openFdError` when `/dev/fd` cannot be listed). Desktop builds collect it but do not send it anywhere yet.
