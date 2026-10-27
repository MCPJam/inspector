---
"@mcpjam/inspector": patch
---

A server-provided skill loaded in an earlier turn now makes the shell and saved-server resource reads ask for approval again, including in reopened conversations. Reading a skill's files after a load the server cannot confirm asks the model to load the skill again.
