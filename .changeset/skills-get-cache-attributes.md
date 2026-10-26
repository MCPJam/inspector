---
"@mcpjam/sdk": patch
---

Preserve `ttlMs` and `cacheScope` on `skills/get` and `resources/directory/read` results. `getServerSkillResult` and `assertSkillsGetEnvelope` return the `skills/get` envelope with them, and a verified skill loaded by URI carries them.
