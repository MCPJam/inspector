---
"@mcpjam/inspector": patch
"@mcpjam/sdk": minor
"@mcpjam/widget-react": minor
---

Claude and Claude Desktop clients with plugin extensions show MCP Apps the way Claude does: an App starts in the chat and, once its tool call returns without an error, moves to the side panel if its `ui://` resource sets `_meta.ui.preferredDisplayMode: "fullscreen"`. An App that supports only full screen opens in the side panel with an Open App card in the chat. These clients start with only the Display modes extension on, and a client's `pluginExtensions.behavior` setting can choose ChatGPT's or Claude's rules field by field. ChatGPT, Codex and every other client behave as before. In `@mcpjam/widget-react`, the `displayBehavior` surface setting replaces `openAIDisplayModes`.
