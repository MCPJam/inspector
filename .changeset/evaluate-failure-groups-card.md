---
"@mcpjam/inspector": patch
---

The evaluate run page can group judged failures into a Case → Route → Reason flow

**A pile of failed trials is a flow, not a scatter.** Behind `evaluate-failure-groups-enabled` a completed run grows a collapsed card that asks the suite for failure groups and draws one ribbon per failed trial — or shows the flat list when clustering did not split. Flag off is no query and no DOM.
