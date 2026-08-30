---
"@mcpjam/sdk": patch
"@mcpjam/inspector": patch
---

`tasks/list` also treats an empty-string cursor as a cursor, not the end of a listing

The follow-up to the same fix for `tools`/`prompts`/`resources`/`resource templates`/`skills`. `tasks/list` belongs to the separately-versioned 2025-11-25 in-core tasks utility rather than to the core listing set, so it was left out of that change's scope; it carried the identical defect.

MCP `2026-07-28` (and `draft`) `server/utilities/pagination`:

> Clients MUST treat cursors as opaque tokens: ... Don't make any determination based on cursor value other than whether a non-null value was provided (e.g. an empty string is a valid cursor and thus MUST NOT be treated as the end of results)

Two sites forwarded the cursor by truthiness — the SDK's `tasks/list` request params, and the hosted `/api/web/tasks/list` request body. A `""` handed back by the previous page was dropped on the way out, which does not end a caller's walk so much as silently restart it at page one. Both now forward by presence.

No repeated-cursor guard was added anywhere on this path, and none exists to remove. Comparing two cursors for equality is itself a determination based on cursor value: nothing requires a server to change its token between pages, and `""` is the spec's own example of a valid one — so a cycle check would break the exact case the clause exists to protect. Bounding a walk is the caller's page cap, which limits our own work rather than interpreting somebody else's token.

Nothing in this repo walks `tasks/list` — every caller reads a single page, and the Tasks tab issues it deliberately as one inseparable batch — so this changes no behaviour against a server that pages normally. It is what lets a caller that does walk, or a user passing `mcpjam tasks list --cursor ""`, reach page two.
