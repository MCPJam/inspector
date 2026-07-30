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
only for `tools/call`, `resources/read` and `prompts/get`, so a blank cannot
distinguish a `-32020` from correct behavior.

Era-gated identically: before `2026-07-28` nothing is mirrored, so every header
comes back `unchecked` rather than judged by rules its version never had.
`Mcp-Param-*` is reported `unchecked` too — the captured body values carry no
arguments, so no verdict is reachable without the tool's `inputSchema`
annotations. `findMcpHeaderIssues` now derives from the same evaluation; its
output shape and version scoping are unchanged.
