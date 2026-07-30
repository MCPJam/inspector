---
"@mcpjam/sdk": minor
---

Add `evaluateMcpHeaders` (exported from `@mcpjam/sdk/browser`) — per-header
verdicts for the SEP-2243 mirrored `Mcp-*` headers, alongside the existing
defect-list form `findMcpHeaderIssues`.

A defect list answers "what is broken"; a debugger also has to answer "is this
right", which needs a row per header carrying the body field it was checked
against. Two cases only a verdict list can express: a conforming header (no
defect, but nothing said either) and an ABSENT one — `Mcp-Name` is required
only for `tools/call`, `resources/read`, `prompts/get` and the SEP-2663 routed
task methods, so a blank cannot distinguish a `-32020` from correct behavior.

Era-gated identically: before `2026-07-28` nothing is mirrored, so every header
comes back `unchecked` rather than judged by rules its version never had. A
`Mcp-Param-*` value cannot be cross-checked either — the captured body values
carry no arguments — though a malformed base64 sentinel in one is still
reported, since servers MUST reject a recognized `Mcp-Param-{Name}` carrying
invalid characters. `Mcp-Session-Id` / `Last-Event-ID` have no encoded form in
any version and are never judged.

Two behavior changes to shipped code:

- `Mcp-Name` is now required for `tasks/get`, `tasks/update` and `tasks/cancel`
  (SEP-2663 "Streamable HTTP: Routing Headers" makes it a MUST, and
  `wrapFetchForTaskRouting` already sends it) — so `findMcpHeaderIssues` reports
  a `missing` defect for a routed task request that omits it, where it was
  previously silent. `TASK_ROUTED_METHODS` now lives with the header logic and
  is read by both the send and judge halves so they cannot drift.
- `deriveMirroredBodyValues` reads `params.taskId` as the `Mcp-Name` source for
  those three methods, and for no others.

`findMcpHeaderIssues` otherwise derives from the same evaluation; its output
shape and version scoping are unchanged.
