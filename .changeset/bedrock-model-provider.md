---
"@mcpjam/sdk": minor
"@mcpjam/inspector": minor
---

Add Amazon Bedrock as a model provider. The SDK's `ModelFactory` now resolves Bedrock models via `@ai-sdk/amazon-bedrock`; the inspector's model-picker, org model config, and eval runner all support Bedrock model IDs alongside existing OpenAI/Anthropic entries.
