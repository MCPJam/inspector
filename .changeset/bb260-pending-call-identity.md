---
"@mcpjam/inspector": patch
---

Persist pending chat calls separately and bind recovery to a specific call and authorization flow. Keep bounded sanitized failure records across reloads, and prevent one direct sign-in from overwriting an unrelated waiting call. A finished sign-in waiting to replay on one server no longer blocks protected calls on other servers. Bring-your-own-key chats now settle a call that a sign-in suspended, so the next message no longer fails with a missing tool result, and the saved transcript includes that settlement.
