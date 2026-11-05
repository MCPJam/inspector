---
"@mcpjam/sdk": minor
---

The host config canonicalizer keeps `mcpProfile.apps.modelContextPolicy`, a client's budgets for plugin App context (`updateMaxBytes`, `maxBlocks`, `turnMaxBytes`), and `resolveModelContextPolicy` reads them. A key the client never saved resolves to MCPJam's defaults (256 KiB per update, 64 blocks, 1 MiB per turn); canonicalization refuses unknown keys, non-integers, and values over 4 MiB, 1024 blocks or 8 MiB. The four mid-session sign-in knobs (`unauthorizedChallenge`, `unauthorizedChallengeTrigger`, `toolResultAuthChallenge`, `toolResultAuthChallengeTrigger`) are now kept and hashed instead of dropped, so a config carrying them gets the content address the backend stores for it.
