---
"@mcpjam/sdk": minor
---

Expand the MCP conformance suite to judge 2026-07-28 (draft) servers.

- Protocol versions are now classified by era in a `satisfies Record<McpProtocolVersion, MCPCheckEra>` map, so adding a supported version is a compile-time obligation to assign its check set. An unknown `protocolVersion` fails configuration instead of silently falling back to legacy.
- New modern MUST checks (`modern-*`), covering `server/discover`, wire `resultType`, cacheable `ttlMs`/`cacheScope`, reserved-header mismatches (`-32020`), unsupported envelope versions (`-32022`), undeclared client capabilities on `input_required` (`-32021`), removed methods (`-32601`), unknown resources (`-32602`), level-gated logging, and sessionless responses. Each raw check asserts the HTTP status and the in-band JSON-RPC code as separate facts.
- New `MCPConformanceResult.readiness`: SHOULD/RECOMMENDED/MAY interoperability advice (tool ordering, metadata quality, deprecated features, cache TTL usefulness, OAuth `iss`) reported as warnings that never affect the conformance verdict.
- New optional `logProbe` config, alongside `inputRequiredProbe`, naming a tool that emits log records.
- Raw frame inspection is consolidated on one production capture primitive (`sdk/src/mcp-conformance/raw-capture.ts`), replacing the private SSE parser in the transport checks.

Legacy runs (absent pin and a 2025-era pin) keep their existing statuses; modern-only checks era-skip on legacy, and legacy-only checks era-skip on modern.
