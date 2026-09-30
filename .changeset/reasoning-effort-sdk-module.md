---
"@mcpjam/sdk": minor
"@mcpjam/inspector": patch
---

Add the reasoning-effort helpers to `@mcpjam/sdk/browser`: `supportedReasoningEfforts` (what a control may offer for a model on a route or harness), `reasoningEffortProviderOptions` (moved from the inspector), `selectionConfigKey` (selection identity including settings) and `selectionIfMatches`. The level tables stay on `@mcpjam/sdk/host-config/internal`.

Behaviour change on the direct route: `reasoningEffortProviderOptions` now refuses model/level pairs the provider documents as unsupported instead of forwarding them, so a saved direct selection that used to reach the provider and fail there now gets `capability_missing` up front. This covers Opus 4.5 with `max`, Haiku and Sonnet 4.5 and earlier, `gpt-5` with `none`, `gpt-5.1` with `minimal`, Codex with `none`, `-pro` and `-chat` models, `o1-mini`/`o1-preview`, and Gemini 3 Pro with `minimal`.
