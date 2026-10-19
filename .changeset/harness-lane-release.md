---
"@mcpjam/inspector": patch
---

Free a harness chat or swarm session after its turn could not be saved, whether the save was rejected or threw, so the next turn no longer waits for the lease to expire, and let a v1 chat turn commit its harness session with the transcript.
