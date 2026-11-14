---
"@mcpjam/inspector": patch
---

`process.vitals` now reports `openFdCount` on hosted servers (`null` plus the errno in `openFdError` when `/dev/fd` cannot be listed), with a row of its own when that count moves by 64 or the listing starts failing. Desktop builds collect it but do not send it anywhere yet.
