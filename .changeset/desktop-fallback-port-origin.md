---
"@mcpjam/inspector": patch
---

The desktop app no longer refuses its own requests with 403 Forbidden when another program holds port 6274 and it starts on the next free port. It used to stay on the loading screen with "Couldn't refresh your session."
