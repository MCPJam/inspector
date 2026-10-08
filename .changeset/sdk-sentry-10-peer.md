---
"@mcpjam/sdk": patch
---

Accept `@sentry/node` 10 as the optional Sentry peer (`^8.55.0 || ^10.0.0`). The SDK's error reporting only uses `NodeClient`, `Scope`, `defaultStackParser` and `makeNodeTransport`, which both majors provide.
