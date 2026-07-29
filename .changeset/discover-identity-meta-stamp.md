---
"@mcpjam/sdk": patch
---

Fix `modern-server-discover` failing every spec-correct 2026 server. The check demanded a top-level `serverInfo` in the `server/discover` result, but `DiscoverResult` has no such member — the 2026 encode seam stamps identity into `_meta["io.modelcontextprotocol/serverInfo"]` on every result instead (spec PR #3002). Any server built on the official server SDK, MCPJam's own stateless reference server included, failed the check.

The check now reads the `_meta` stamp, keeps a top-level `serverInfo` as a lenient fallback, and treats identity as the SHOULD it is: a present-but-malformed stamp still fails, an absent one does not, and either way the value is reported in the check details so a silent server stays visible in the run artifact. `supportedVersions` and `capabilities` remain hard MUST failures.

Also repairs test rot from the 2.0.0 client bump so the SDK suite is green again: `connect({ prior })` is now era-discriminated (`{ kind: "modern", discover }`), and upstream's default validators no longer reject a declared draft-07 dialect — that assertion is re-pointed at the boundary that is still real (draft-04). Upstream now covering draft-06/07/2019-09/2020-12 makes `DialectAwareJsonSchemaValidator` and its CSP-safe twin redundant for the dialects they dispatch; retiring them touches the client factory and the browser/workerd bundles, so it is left as a separate deliberate change.
