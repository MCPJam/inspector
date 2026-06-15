---
"@mcpjam/inspector": patch
---

Internal: `chat-v2/thread/thread-helpers` is now single-sourced from
`@mcpjam/chat-ui/thread-helpers` via a re-export shim instead of a duplicated
local copy, removing drift between the inspector and the package. No behavior
change.
