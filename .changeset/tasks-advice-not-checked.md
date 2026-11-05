---
"@mcpjam/sdk": patch
"@mcpjam/inspector": patch
---

Tasks conformance now says when the "Failed Task Status Message" advice could not be checked: a run whose task never failed reports it in a new `uncheckedAdvice` list ("Not checked: the task didn't fail, so there was no failure reason to look at."), shown as a grey line in the Tasks results. It is kept apart from `readiness`, so it never costs points.
