---
"@mcpjam/sdk": minor
---

HostConfig standalone-skill selection contract. Additive optional field; every existing HostConfig canonicalizes and hashes byte-identically.

- `HostConfigInputV2` gains optional `skillSelection?: { mode: "all-visible" } | { mode: "explicit"; skillIds: string[] }`, threaded through the canonical form, public `HostJson`/`HostInit`, templates, and parity fixtures. Hosts carry NO plugin-specific fields — plugin component servers attach via ordinary `serverIds`, and plugin-imported skills are ordinary materialized skill rows selectable by id through `skillSelection`.
- Canonicalization: explicit `skillIds` deduped + sorted; `{ mode: "all-visible" }` canonicalizes to absent (single content-addressed identity per behavior); explicit-empty `skillIds: []` is preserved and hashes distinctly from absent (absence is semantic).
- External SDK eval wire normalization strips `skillSelection` (explicit skill ids are platform-internal, not portable); platform-owned suites keep it in persisted HostConfigs.
- `schemaVersion` stays 2. New parity fixture vectors cover the added semantics for backend consumption.
