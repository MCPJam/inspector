---
"@mcpjam/chat-ui": minor
---

Add a `@mcpjam/chat-ui/thread-helpers` subpath export exposing the pure
part/tool shape helpers (`AnyPart`, `ToolState`, `getToolInfo`,
`groupAssistantPartsIntoSteps`, `getToolStateMeta`, …) without loading the React
renderer / markdown graph. Lets hosts single-source these helpers cheaply.
