---
"@mcpjam/inspector": patch
---

Keep chats within the model's context window. An oversized tool result now reaches the model as its start and end, and older tool results are cleared when a long chat runs out of room, instead of the turn failing with "prompt is too long". The chat says when either happens.
