---
"@mcpjam/inspector": patch
---

Streaming a reply with the Timeline or Raw trace view open no longer sets state after every token. The trace viewer resets its timeline filter, zoom, expansion and reveal highlight during render instead of from effects, and view-only JSON renders without the edit buffer that re-serialized the value on every change. A rebuilt trace with unchanged spans no longer resets the timeline filter or expansion.
