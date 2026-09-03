---
"@mcpjam/inspector": patch
---

Mark a server's connection status where servers are picked, and stop preselecting one that failed (BB-49). The server-group create form drew its pool from Convex, which knows a server's config but not whether it answers, so a server that had failed to connect was offered exactly like a working one — and, in a small project, arrived already ticked and giving the group its name. The form now joins the live status in, draws it on each row (colour plus the status in the row's accessible name), and leaves a failed server unticked. `disconnected` still preselects: that is what every server reads on a fresh load.
