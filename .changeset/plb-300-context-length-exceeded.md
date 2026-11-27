---
"@mcpjam/sdk": patch
"@mcpjam/inspector": patch
---

A chat too long for the model's context window now shows "Chat too long for this model", with the token counts when the provider states them, the next steps, Choose another model and Reset chat, instead of "An error occurred" and the provider's raw sentence. The same title appears on hosted chats, chats on your own provider key, eval iterations and swarm sessions. The SDK error describer recognizes the refusal as `provider/context_length_exceeded` and exports `CONTEXT_LENGTH_EXCEEDED_MESSAGE` and `contextLengthCounts`.
