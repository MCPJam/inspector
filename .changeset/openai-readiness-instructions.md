---
"@mcpjam/sdk": patch
---

`gatherOpenAIReadinessEvidence` now keeps the server's `instructions` from `initialize` as `instructions` on the evidence, since the model reads them too, and `packageSelfDescription(pkg)` is exported: what a plugin package says about itself (its manifest description, interface name and short description, and skill descriptions) as `{ field, text }` entries. Together they are the text a ChatGPT run's decision questions read besides its tools.
