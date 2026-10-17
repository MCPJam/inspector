---
"@mcpjam/inspector": patch
---

Stopping the Inspector Docker container now shuts the server down gracefully instead of killing it: the image runs the launcher directly, so the stop signal reaches it.
