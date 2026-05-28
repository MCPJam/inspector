---
"@mcpjam/inspector": minor
---

- Remove `/chat-v2` tab and retire the `playground-tab-enabled` flag; Playground replaces App Builder as the only post-connect destination.
- Org-scoped home dashboard at `/home`.
- Model picker: separate tabs for Free models and Your providers.
- Agent tab respects the per-tool visibility toggle.
- Apps: preview `window.openai` methods when injection is off; widgets open inline by default instead of being forced fullscreen; `window.openai.setOpenInAppUrl` implemented; App Builder app-tool execution routed through AppBridge.
- Per-server protocol-version override is always visible and functional.
- Fix hosted mixed-protocol tools.
