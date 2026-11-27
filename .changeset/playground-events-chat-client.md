---
"@mcpjam/inspector": minor
---

In the hosted Playground, event subscriptions from the Events pane and from the agent are made as the chat's client, in the modes that client receives, instead of as MCPJam (built-in). The agent gets its Events tools whenever the chat's client has a mode it can subscribe by here, whatever its Apps style. When an event is already subscribed under another client, the message names that client and the Events tab shows the backend's reason instead of a generic server error.
