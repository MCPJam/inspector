---
"@mcpjam/sdk": minor
---

Add `builtInToolIds` as a HostConfig v2 dimension. Host configs can now carry an opaque list of built-in tool catalog ids (a peer dimension to `serverIds`). The canonicalizer validates wire shape (array of non-empty strings), then dedupes and sorts; an absent or empty list is omitted from the canonical JSON, so every existing host config keeps a byte-identical `configHash`. IDs remain opaque to the SDK — existence and org-scope are enforced by the backend catalog, not an SDK enum.
