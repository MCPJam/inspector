---
"@mcpjam/inspector": patch
---

The launcher no longer force-kills the server before the server's own shutdown deadline, so a slow shutdown still ends with its logs written.
