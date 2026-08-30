---
"@mcpjam/sdk": patch
"@mcpjam/cli": patch
"@mcpjam/inspector": patch
"@mcpjam/widget-react": patch
---

An empty-string `nextCursor` is a valid cursor, not the end of a listing

MCP `2026-07-28` (and `draft`) added a client MUST NOT to `server/utilities/pagination`:

> Clients MUST treat cursors as opaque tokens: ... Don't make any determination based on cursor value other than whether a non-null value was provided (e.g. an empty string is a valid cursor and thus MUST NOT be treated as the end of results)

Every page walk over `tools/list`, `prompts/list`, `resources/list`, `resources/templates/list` and `skills/list` treated `nextCursor: ""` as "that was the last page", so a server that pages with an empty first cursor had everything past page one silently dropped — tools missing from the Tools tab, a declared MCP App reported as undeclared, a conformance check certifying a listing it never finished reading, and a valid eval suite rejected at import because the tool it references sits on a page the validator never read.

Both halves are fixed. A walk now ends only when `nextCursor` is absent (or is not a string, which is not a cursor at all), and a cursor is forwarded on the next request by presence rather than truthiness — the second half matters on its own, because a dropped `""` did not end the walk so much as restart it at page one.

This reaches the public surfaces too. The `/v1` tools, prompts and resources routes are a **passthrough** of the MCP server's cursor, not our own pagination, so the same rule applies to them: `v1Page` no longer strips an empty `nextCursor`, the platform operations forward and surface one in both directions, and the `list_server_*` input schema accepts `cursor: ""` instead of rejecting it as too short. Convex-backed routes are unaffected — they already normalize a spent cursor to `undefined` before building the envelope.

The same clause also removes the repeated-cursor guards these walks carried. Comparing two cursors for equality is itself a determination based on cursor value: nothing requires a server to change its token between pages, a server holding its pagination state server-side may legally return one constant opaque handle, and the spec's own example of a valid cursor is `""` — so a cycle check would have broken the empty-string case at page two, which is the very case this fix exists for. The guards never bounded the adversarial server anyway (one that wants to spin a client emits distinct cursors forever), so what remains is the **page cap**: it bounds our own work instead of interpreting somebody else's token, it bounds both cases identically, and every walk reports a cap stop as an incomplete read rather than as a finished listing.

One deliberate exception: the conformance checker still records a repeated cursor, because characterizing a server's behavior is its purpose. It reports it as its own non-complete terminal state, which callers turn into a "could not run" skip — never a pass, never a failure, and never a listing described as complete.
