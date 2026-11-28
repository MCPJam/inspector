---
"@mcpjam/inspector": patch
---

Saving a server whose URL moves to a different origin (scheme, host or port), or whose stdio command changes, no longer asks for confirmation. Its saved credentials are still cleared, and the Config tab notes when a URL change cleared them.
