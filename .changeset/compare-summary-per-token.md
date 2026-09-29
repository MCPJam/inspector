---
"@mcpjam/inspector": patch
---

Streaming a reply in the playground's compare view no longer trips React's "Maximum update depth exceeded". Each compare card now reports its summary to the view when its duration, token count or tool count changes, instead of once per streamed token.
