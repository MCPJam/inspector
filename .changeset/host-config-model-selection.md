---
"@mcpjam/sdk": minor
---

Add a saved model selection type beside a host config's model id.

`HostConfigInputV2` gains an optional `modelSelection`: the canonical model id, whose credentials serve it (`source: "hosted" | "org" | "local"`), which connection (`connectionRef`, never a key), an optional native or deployment id, optional settings (reasoning effort, temperature) and the permitted fallback. `modelId` stays required. When both are set they must name the same model; the canonicalizer throws on a mismatch instead of picking one. A config without `modelSelection` canonicalizes and hashes exactly as before.

`@mcpjam/sdk`, `@mcpjam/sdk/browser`, `@mcpjam/sdk/host-config` and `@mcpjam/sdk/host-config/internal` export the types (`ModelSelection`, `ModelConnectionRef`, `LegacyModelSelection`, `RequestedModelSelection`, …) and helpers: `validateModelSelection` (structured issues; rejects unknown keys, so a field like `apiKey` can never be saved), `isModelSelection`, `assertModelSelection`, `selectionFromLegacyModelId`, `isLegacySelection`, `selectionKey` and `defaultFallbackForPurpose`.

`EvalSuite.runWithClient` only runs hosted MCPJam models. It now refuses a saved client whose `modelSelection` uses an organization or local provider, throwing `UnsupportedModelSelectionError` (exported from `@mcpjam/sdk`, with `source` and `modelId`), instead of running that model on MCPJam's key. Clients with a hosted selection, or with no selection, run exactly as before.
