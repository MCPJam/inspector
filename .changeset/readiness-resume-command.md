---
"@mcpjam/cli": minor
---

`mcpjam readiness resume --run <id>` runs again a hosted readiness run that stopped on the server; only the person who started it can. `readiness submission run --wait` does this on its own: when a read reports the run `resumable`, it resumes it once and keeps waiting.
