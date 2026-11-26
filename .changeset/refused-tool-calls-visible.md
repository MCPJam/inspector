---
"@mcpjam/inspector": patch
---

The Tools tab of an eval iteration now lists each call MCPJam refused before it reached the server, labeled "Refused by client", with the arguments the model sent and the error it got back. Refused calls stay out of the expected and actual comparison, and verdicts don't change.
