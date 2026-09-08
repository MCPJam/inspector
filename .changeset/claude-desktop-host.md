---
"@mcpjam/sdk": patch
"@mcpjam/inspector": patch
---

Add Claude Desktop as its own host. The existing `claude` host is claude.ai in a browser; the Electron app differs in ways a widget can feel — it offers no fullscreen display mode, sends no `toolInfo`, and gives the widget iframe zero safe-area inset instead of 12px. Probed 2026-09-03 on Claude/1.40609.1. Style variables, fonts and CSP behaviour are identical to the web app and are shared rather than copied.
