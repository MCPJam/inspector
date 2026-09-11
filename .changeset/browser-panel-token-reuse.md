---
"@mcpjam/inspector": patch
---

Stop the Browser Panel from minting a browser token on every request, and stop its keepalive and lease heartbeat from silently retrying forever once the browser is gone. A computer released or auto-paused under an open panel now says so instead of logging one uncaught server error per minute for as long as the tab stays open.
