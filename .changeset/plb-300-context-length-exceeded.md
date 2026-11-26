---
"@mcpjam/sdk": patch
"@mcpjam/inspector": patch
---

A chat too long for the model's context window now shows "Chat too long for this model", with the token counts when the provider states them, the next steps and Reset chat, instead of "An error occurred" and the provider's raw sentence. The SDK error describer recognizes the refusal as `provider/context_length_exceeded`.
