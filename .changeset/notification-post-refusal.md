---
"@mcpjam/sdk": patch
"@mcpjam/inspector": patch
---

Pass the Notification POST Accepted check when the server declines a notification with an HTTP error. When the server accepts the notification, the check still requires HTTP 202 with an empty body.
