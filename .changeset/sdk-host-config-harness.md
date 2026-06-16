---
"@mcpjam/sdk": minor
"@mcpjam/inspector": patch
---

Add an optional `harness` field to HostConfig v2 (new `Harness` type; value
`"claude-code"`). It selects how a host config executes: absent ⇒ MCPJam's
emulated loop (the only prior behavior, so pre-feature rows hash
byte-identically), while `"claude-code"` marks the host to run on a real Claude
Code runtime via the AI SDK harness (the runtime itself lands in later changes).
The canonicalizer validates the value as a closed enum. Exported as `Harness`
from `@mcpjam/sdk` and `@mcpjam/sdk/host-config`.
