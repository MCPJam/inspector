---
"@mcpjam/sdk": patch
---

Functional SSE Streams keeps replies that arrive before the probe deadline. Streams that stay open after replying or close cleanly without a reply can pass. Silent or cut-off streams report Could not run when the probe has incomplete evidence.

The check's source link points to Multiple Connections.
