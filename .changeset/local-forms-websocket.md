---
"@mcpjam/inspector": patch
---

Keep local form requests and answers responsive across tabs by using an authenticated WebSocket.

Local form rounds and answers have an explicit 30 MiB aggregate limit. Oversized rounds fail before opening a form and ask the server to split the request.
