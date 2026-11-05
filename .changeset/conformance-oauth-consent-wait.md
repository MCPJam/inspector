---
"@mcpjam/inspector": patch
---

Conformance: the OAuth suite now waits up to 10 minutes for you to finish signing in and consenting, instead of failing after 30 seconds. A session that sits idle too long now says "Authorization took too long. Run the checks again." instead of "Session not found".
