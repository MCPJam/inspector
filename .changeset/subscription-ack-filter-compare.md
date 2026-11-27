---
"@mcpjam/sdk": patch
---

The three subscription checks now compare the filter the server acknowledged with the one they asked for. The check details list what the server left out (`notAcknowledged`) and what it confirmed without being asked (`acknowledgedNotRequested`). A server may honor only part of a request, so a difference never fails a check.
