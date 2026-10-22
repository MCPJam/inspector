---
"@mcpjam/inspector": patch
---

`npx @mcpjam/inspector` no longer refuses to start when port 6274 is taken, for example by the desktop app or another Inspector. Without `--port` it now starts on the next free port (up to 6283) and says which one it chose. An explicit `--port` still uses exactly that port or fails.
