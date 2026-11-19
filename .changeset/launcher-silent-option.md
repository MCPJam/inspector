---
"@mcpjam/inspector": patch
---

Add a `silent` option to `launchInspector()` and the Vite plugin that keeps the inspector's output out of your terminal. `launchInspector()` now returns a URL with its session token, and rejects right away, with the end of the inspector's output, if the inspector exits before it is ready. Another inspector already running on the port is no longer mistaken for the new one.
