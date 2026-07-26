---
"@mcpjam/sdk": minor
---

Thread the SEP-2549 response-cache disposition (`cacheMode`) through the manager's cacheable read verbs and add a local cache-serve provenance channel.

- `ClientRequestOptions` now carries an optional `cacheMode` (`"use" | "refresh" | "bypass"`); the type is re-exported as `CacheMode` (plus `CacheScope`). `listTools` / `listResources` / `listResourceTemplates` / `listPrompts` / `readResource` (and the `operations.ts` params) forward it to the underlying client.
- New `MCPClientManagerOptions.cacheEventLogger` reports fresh cache serves (`{ serverId, method, params, ageMs, scope }`) via a new `ObservableResponseCache` store wrapper. This is a channel DISTINCT from `rpcLogger`: a cache hit never touches the wire and is never a wire-log entry.
- Raw-evidence surfaces (`server-snapshot`, `server-doctor`, `mcp-conformance` list/read checks) pass `cacheMode: "bypass"` so they always exercise the live wire.
- `defaultCacheTtlMs` is left at its `0` default: a result without a server-sent `ttlMs` is stored but never served. Persisted-discovery (`prior` DiscoverResult) reconnect is explicitly deferred.
