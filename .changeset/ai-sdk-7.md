---
"@mcpjam/sdk": major
"@mcpjam/chat-ui": minor
"@mcpjam/inspector": patch
---

Move to AI SDK 7 (`ai@7`) and the v7 line of every model provider package.

`@mcpjam/sdk` now requires Node.js 22 or later, depends on `ai@7`, and emits model-visible MCP tool images as AI SDK 7 `file` parts (`{ type: "file", mediaType, data: { type: "data", data } }`) instead of `media` parts, which AI SDK 7 rejects. Read image parts with the new `readModelOutputImage`, which also accepts the older `media` and `image-data` shapes. Model-visible MCP tool images now reach the model in runs driven by the SDK, which its older provider packages had been dropping.

`@mcpjam/chat-ui` now peers on `ai@^7` and `@ai-sdk/react@^4`.
