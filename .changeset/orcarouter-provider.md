---
"@mcpjam/sdk": minor
---

Add OrcaRouter as a built-in LLM provider.

`@mcpjam/sdk` now recognizes the `orcarouter/` model prefix (`orcarouter/anthropic/claude-sonnet-5`, `orcarouter/openai/gpt-4o`, ...) in `createModelFromString` and the org-resolved provider builder. OrcaRouter is an AI gateway that fronts many upstream models behind a single OpenAI-compatible Chat Completions endpoint; models route through the OpenAI adapter with the well-known default base URL `https://api.orcarouter.ai/v1` (overridable via `baseUrls.orcarouter` or an org provider's `baseUrl`), using `.chat()` since the gateway does not implement the newer `/v1/responses` API.
