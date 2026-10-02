---
"@mcpjam/inspector": patch
---

The local inspector (desktop and `npx`) no longer refuses requests from its own page when `ALLOWED_ORIGINS` is set in the environment, and a refused origin is now named in the error.
