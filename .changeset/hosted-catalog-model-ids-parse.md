---
"@mcpjam/sdk": minor
---

`parseLLMString` accepts every MCPJam-hosted catalog id

**A model id copied out of MCPJam threw at `new HostRunner(...)`.** The hosted
catalog `list_models` and the model picker hand out is majority canonical
OpenRouter-style ids whose first segment is a VENDOR — `qwen/qwen3-max`,
`z-ai/glm-4.6`, `moonshotai/kimi-k2`. `parseLLMString` read that segment as an
MCPJam provider key and threw `Unknown LLM provider` for anything outside its
ten built-ins, so the documented copy-an-id workflow failed at construction for
most of the catalog.

Three widening changes, all in `src/model-factory.ts`:

- The picker's `HOSTED_PROVIDER_ALIASES` table is now honoured here too, so
  `x-ai/grok-4-fast` resolves to the `xai` provider. Registered custom
  providers are still matched first, so an alias can never shadow one.
- A vendor path whose leading segment is not a provider resolves to
  `openrouter` with the whole id as the model, which is how MCPJam serves it.
- The remaining bare-id error names the supported providers and says that a
  catalog id already carries its vendor.

Nothing that parsed before parses differently. A test walks the committed
hosted-catalog snapshot and asserts every id in it parses.
