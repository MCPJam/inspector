---
"@mcpjam/sdk": minor
---

Add `@mcpjam/sdk/variants` (beta) for server variants with edited tool descriptions. `pinVariantSurface` reads and hashes every `tools/list` page of a saved server, `buildVariantDraft` checks description edits against it and refuses bad ones with the variant error codes, and `createVariantFetch` serves the variant by passing every request through to the base, rewriting only `tools/list` and answering `VARIANT_BASE_DRIFTED` when an edited tool has changed.
