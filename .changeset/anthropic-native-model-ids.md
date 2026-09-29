---
"@mcpjam/sdk": patch
"@mcpjam/inspector": patch
---

Fix BYOK Anthropic models named with the hosted catalog's canonical spelling (`anthropic/claude-sonnet-4.5`): `createModelFromString`, and every `HostRunner` built on it, now calls api.anthropic.com with the reviewed native id (`claude-sonnet-4-5`) instead of an id Anthropic does not serve. Native ids, dated snapshots and ids the table does not know pass through unchanged, and MCPJam-hosted `mcpjam/anthropic/…` routing still sends the canonical id.

The reviewed table is exported as `ANTHROPIC_NATIVE_MODEL_IDS`, with `anthropicNativeModelId`, from `@mcpjam/sdk` and `@mcpjam/sdk/model-factory`. The Inspector's BYOK Anthropic adapter now reads the same rows, so the models it lists and the id an SDK eval sends cannot disagree.
