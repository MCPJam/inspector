---
"@mcpjam/sdk": minor
---

Validate what the server actually sent against the spec's own JSON Schema.

The 2026-07 conformance sweep compared our 36-check pool against the official
suite across nine production connectors. The official `wire-schema-valid` found
74 real violations on six of them — `tools/list` results missing the REQUIRED
`cacheScope` / `resultType` / `ttlMs`, and response envelopes carrying
`"id": null` where `RequestId` is `["string", "integer"]`. Our two hand-written
field checks abstained on seven of nine. A hand-written check can only catch
what its author remembered; the schema is the complete statement.

`wire-schema-valid` grades every JSON-RPC message a run observed against the
published schema for the revision being spoken. It sends no requests of its
own — it runs last and reads what the other check families already made the
server say, so a whole family of assertions costs zero extra traffic.

Correlation is what makes it non-vacuous. `ServerResult` includes a base
`Result` branch that requires only `resultType` and allows every other
property, so grading a `tools/list` response against the generic message union
accepts exactly the defect the sweep found. Responses are therefore paired to
their request by JSON-RPC id and graded against that method's result
definition. The method → result map is derived from each vendored document's
own request definitions rather than typed out, so a revision that renames a
method cannot leave a stale table behind.

Supporting this, a run-wide observed-message recorder now exists at all: the
raw check families run concurrently and each built its own requests, so
"everything this run observed" was not a thing anywhere. It is fed at two
non-overlapping seams — inside `rawRequest` (covering every raw probe by
construction) and on the official Client's `baseFetch` (the only place its
traffic is visible before the client consumes the wire-only members).

All four core revisions plus the tasks extension schema are vendored verbatim
with pinned upstream commits. Both Ajv dialects are needed: 2025-03-26 and
2025-06-18 are draft-07, the later two 2020-12. When the tasks extension is
negotiated, `tools/call` is graded against `anyOf: [CallToolResult,
CreateTaskResult]`, so a server that implements the extension is not failed for
it.

The check lands in the `pending` bucket introduced with the conformance
profile: it reports real verdicts and moves no score until a profile version
promotes it. Node-only (Ajv compiles with `new Function`), so it is absent from
the browser and worker entries.

Also fixes the conformance mock server, which the new check caught answering a
well-formed request's error with `id: null` — JSON-RPC 2.0 reserves that for
requests whose id could not be detected.
