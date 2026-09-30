---
"@mcpjam/inspector": patch
---

A row you close in the Trace view now stays closed while a reply streams. Before, the row opened again on every new word, because the trace reopened every row whenever a bar got longer. Rows now open by default only when they first appear.
