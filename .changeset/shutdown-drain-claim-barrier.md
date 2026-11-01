---
"@mcpjam/inspector": patch
---

A shutdown drain now also waits for a claim answered after the claim loops were told to stop, so the job it starts gets the drain like any other, and a drain setting too long for Node's timers is held to the longest they can wait instead of ending the shutdown at once.
