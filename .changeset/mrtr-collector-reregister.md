---
"@mcpjam/inspector": patch
---

Fix MRTR elicitation silently dying for the rest of the process after one
failed connect.

`MCPClientManager.removeServer()` purges `mrtrInputCollectors` by design, and
the local connect route runs with `removeOnFailure: true` — so any failed
connect (or an explicit remove from the servers route) drops the collector.
`registerLocalMrtrCollector` mirrored "already registered" in a module-level
`WeakMap<manager, Set<serverId>>` that could not observe that purge, so after
the first failure it answered "already registered" forever and never restored
the collector.

Downstream, `buildCapabilities` advertises `elicitation` exactly when a
collector is registered, so every subsequent connection advertised none. A
2026-07-28 server then correctly refuses to embed `elicitation/create` in an
`input_required` result, and every MRTR surface — `tools/call`,
`resources/read`, `prompts/get` — fails with "the request's client capabilities
do not declare the required capability". The connection succeeds and the tool
list populates, so nothing looks broken until a tool is actually run.

The mirror is removed: the manager's own collector map is now the single source
of truth, and registration is unconditional. Re-registering is a `Map.set` with
a pure factory closure (all round state lives in the module-level
`pendingRounds`), so the repeat cost is nil.
