---
"@mcpjam/sdk": minor
---

`computer` is now a pure resource attachment: `{ kind: "personal", workdir? }`. The capability a host grants on the machine moved to `builtInToolIds` (e.g. `"bash"`), the same list every other built-in tool uses — so future computer-backed tools (`files`, …) compose in one list instead of growing a parallel `toolset` union. The canonicalizer still accepts the legacy `{ toolset: "bash" }` input key and drops it, so legacy input hashes identically to the new shape; `null`/absent collapse and eval-wire stripping are unchanged. Hashes of computer-carrying configs change (the `toolset` key leaves the canonical JSON) — acceptable now because no shipped UI writes the field yet.
