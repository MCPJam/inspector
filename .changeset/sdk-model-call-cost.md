---
"@mcpjam/sdk": minor
---

Add per-call model cost helpers. `normalizeModelUsage` turns one request's AI SDK usage into separate uncached-input, cache-read, cache-write, output and reasoning counts, and `extractReportedProviderCost` reads the dollar amount the Vercel AI Gateway or OpenRouter returned. `priceModelCall` prices the request from that amount or from a supplied rate, including context tiers, cache retention and web searches; a part it cannot price makes the result partial or unavailable instead of $0. `aggregateModelCallCosts` sums calls into a known subtotal with coverage counts. The helpers are pure and available from both `@mcpjam/sdk` and `@mcpjam/sdk/browser`.
