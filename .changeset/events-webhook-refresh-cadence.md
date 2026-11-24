---
"@mcpjam/sdk": patch
---

Refresh short Events webhook grants at their midpoint. A grant of 60 s or less was refreshed about once a second, because the 60 s refresh lead covered the whole grant; the lead is now capped at half the remaining grant. Grants longer than 2 min keep the `max(60 s, 10%)` lead.
