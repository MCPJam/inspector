---
"@mcpjam/inspector": patch
---

`launchInspector()` and the Vite plugin now open Playground when `defaultTab` is `"chat"` or `"app-builder"`, and reject a `defaultTab` that is not an Inspector tab with an error that lists the valid tabs.
