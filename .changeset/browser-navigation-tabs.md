---
"@mcpjam/inspector": minor
---

Add browser-style URL/search navigation, Back, Forward, Reload and managed popup tabs to WebMCP and Playground. Browser tabs share one daemon registry across local, cloud and Electron. Node WebMCP uses the shared daemon at pane-sized DPR 1 by default; Electron WebMCP uses native WebContentsView surfaces. Preserve opener relationships and tool invocation bindings across tab changes.
