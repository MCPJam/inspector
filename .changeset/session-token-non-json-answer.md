---
"@mcpjam/inspector": patch
---

When something other than the Inspector answers the local access check (a proxy's error page, another program on the port), the client no longer raises a `SyntaxError`. It reports one `SessionTokenError` that carries the HTTP status and, for HTML or JSON, the content type, so the failure can be traced to what answered.
