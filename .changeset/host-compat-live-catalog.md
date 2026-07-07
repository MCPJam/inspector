---
"@mcpjam/sdk": minor
---

host-compat: split the market-host catalog data from the derivation engine. New exports — `bundledHostCompatCatalog()`, `buildHostProfilesFromCatalog(catalog)`, `hostCompatCatalogSchema` / `hostCompatCatalogEnvelopeSchema`, and `fetchHostCompatCatalog()` — let surfaces evaluate against the live backend-published catalog (`evaluateMarketHosts(tools, { catalog })`) with the bundled constants as offline/OSS fallback. No existing export signatures change.
