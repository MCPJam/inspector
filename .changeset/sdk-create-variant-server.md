---
"@mcpjam/sdk": minor
---

Add `create_variant_server` (beta, behind `variant-servers-enabled`) and `PlatformApiClient.createVariantServer`. A variant is a saved HTTP server's live tool list with edited tool descriptions, stored under a server ID of its own; that ID works wherever a server ID does, such as an ad-hoc environment, and nothing on the base changes. The same base and edits return the existing variant with `created: false`. An eval run's `variants` lists the variants it served. A server config can set `replayable: false` to stay out of replay configs.
