---
"@mcpjam/inspector": patch
---

### `@mcpjam/inspector`
- **Modal widget advertises the same `HostCapabilities` as the inline widget**: previously `mcp-apps-modal.tsx` hardcoded `{ openLinks, serverTools, serverResources, logging, updateModelContext, message }` at AppBridge construction, which masked Copilot's published M365 subset (no `serverResources` / `logging`) and silently ignored user overrides in `mcpProfile.apps.mcpAppsOverrides`. The modal now receives the resolved `effectiveHostCapabilities` from the inline renderer and advertises an identical surface — `app.getHostCapabilities()` returns the same record regardless of which iframe the widget is mounted in. Test added that asserts inline/modal parity on Copilot.
