---
"@mcpjam/sdk": patch
"@mcpjam/cli": patch
"@mcpjam/inspector": patch
"@mcpjam/widget-react": patch
---

An empty-string `nextCursor` is a valid cursor, not the end of a listing

MCP `2026-07-28` (and `draft`) added a client MUST NOT to `server/utilities/pagination`:

> Clients MUST treat cursors as opaque tokens: ... Don't make any determination based on cursor value other than whether a non-null value was provided (e.g. an empty string is a valid cursor and thus MUST NOT be treated as the end of results)

Every page walk over `tools/list`, `prompts/list`, `resources/list`, `resources/templates/list` and `skills/list` treated `nextCursor: ""` as "that was the last page", so a server that pages with an empty first cursor had everything past page one silently dropped — tools missing from the Tools tab, a declared MCP App reported as undeclared, a conformance check certifying a listing it never finished reading.

Both halves are fixed. A walk now ends only when `nextCursor` is absent, and a cursor is forwarded on the next request by presence rather than truthiness — the second half matters on its own, because a dropped `""` did not end the walk so much as restart it at page one.

This reaches the public surfaces too. The `/v1` tools, prompts and resources routes are a **passthrough** of the MCP server's cursor, not our own pagination, so the same rule applies to them: `v1Page` no longer strips an empty `nextCursor`, the platform operations forward and surface one in both directions, and the `list_server_*` input schema accepts `cursor: ""` instead of rejecting it as too short. Convex-backed routes are unaffected — they already normalize a spent cursor to `undefined` before building the envelope.

Because `""` now continues a walk that it used to end, every affected loop that lacked one gained a **repeated-cursor guard**: the HTTP doctor drain, the OpenAI-readiness skills walk, the host-compatibility tool walk, the `cacheScope` conformance walk, the CLI `compat` walk, the MCP-App renderer's bridge walk, the playground tool fetch, and the Tools and Resources tabs' infinite scroll. Each stops the way that site already reports an incomplete read — throwing where the surrounding code throws, flagging `truncated` where it flags, and simply stopping in the UI. Page caps are unchanged, and `""` joins the seen-cursor set like any other token, so a server that answers `""` forever stops on the second occurrence.

Boundaries that read an untyped response or request body now also reject a **non-string** `nextCursor`/`cursor` rather than forwarding a number or object as a continuation token.
