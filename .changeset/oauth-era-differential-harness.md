---
"@mcpjam/sdk": patch
---

Add a differential golden harness across every era, registration strategy, and branch.

`no-emulation-goldens.test.ts` covers one happy ladder per era, `dcr` only, no error branches. That notices an accidental change to the default path and nothing else — a thin basis for trusting four ~50%-duplicated state machines, and far too thin to justify consolidating them.

`era-differential-goldens.test.ts` widens it to 4 eras × each supported registration strategy (`dcr`, `preregistered`, and `cimd` where the era supports it) × a catalog of the branches that actually differ: DCR failure, DCR failure with a pre-registered fallback, `strictConformance` refusing that fallback, present-but-mismatched and absent RFC 9207 `iss`, issuer mismatch, `allowPathScopedIssuer` on and off, each `resourceIndicatorEnforcement` mode, and — for the current-profile eras — missing PKCE metadata, `S256` absent, `plain` alongside `S256`, and empty or absent `authorization_servers`.

Two layers on purpose. The full request-sequence snapshot is a review aid: it shows what changed, and accepting an update is one keystroke. The named assertions are the gate — S256 PKCE end to end, one `redirect_uri` reused, the same validated canonical resource on both the authorization and token requests, a CSRF state always issued, and no MCP bearer credential on any OAuth endpoint. A snapshot update cannot normalize away a violation of those.

Era differences are pinned rather than tolerated. The issuer-mismatch branch asserts that only 2026-07-28 hard-rejects it, so a change to shared code cannot quietly give an older era the strict behavior or take it from the newest one.
