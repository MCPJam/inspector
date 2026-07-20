---
"@mcpjam/sdk": minor
---

HostConfig plugin and skill attachment contract. Additive optional fields; every existing HostConfig canonicalizes and hashes byte-identically.

- `HostConfigInputV2` gains optional `pluginVersionIds?: string[]` and `skillSelection?: { mode: "all-visible" } | { mode: "explicit"; skillIds: string[] }`, threaded through the canonical form, public `HostJson`/`HostInit`, templates, and parity fixtures.
- Canonicalization: `pluginVersionIds` deduped + sorted, omitted when empty; explicit `skillIds` deduped + sorted; `{ mode: "all-visible" }` canonicalizes to absent (single content-addressed identity per behavior); explicit-empty `skillIds: []` is preserved and hashes distinctly from absent.
- External SDK eval wire normalization strips both fields (platform-internal IDs are not portable); platform-owned suites keep them in persisted HostConfigs.
- `schemaVersion` stays 2. New parity fixture vectors cover the added semantics for backend consumption.
