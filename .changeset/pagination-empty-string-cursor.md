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

The existing safety guards are unchanged: the page caps still bound every walk, and `""` joins the repeated-cursor set like any other token, so a server that answers `""` forever stops on the second occurrence instead of spinning.
