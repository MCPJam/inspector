---
"@mcpjam/widget-react": patch
---

`McpAppsRenderer` records an App's `ui/update-model-context` in the debug store only after `onModelContextUpdate` accepts it. A host that refuses the update by throwing from `onModelContextUpdate` now has that error reach the App, and the refused context no longer shows as held.
