---
"@mcpjam/inspector": patch
---

Keep the active project in the URL of every project-owned screen

`https://app.mcpjam.com/p/<projectId>/servers` is now the canonical form, and
the project segment stays in the address bar. Copy, refresh, Back/Forward,
bookmarks, a second tab, and an agent-returned link all reopen the project the
link was minted for instead of whatever project the reader's picker happened to
be parked on.

Opening a project URL selects that project — and its organization — before the
screen renders, so no screen ever shows one project's data under another
project's address. A project that is missing, deleted, or not yours keeps the
requested URL and shows one generic unavailable state; it never falls back to
another project's data, and it never reveals whether the project exists.

Old links keep working. An unscoped path and the legacy `?project=<id>`
convention both normalize onto the canonical path with `replace`, preserving the
rest of the query and the hash; `?project=` is read but never minted again by
the app. Global and public surfaces — Settings, Organizations, Profile, embeds,
share tokens, the WorkOS and MCP OAuth callbacks — stay unscoped. An unknown URL
now renders an explicit not-found instead of quietly rendering Connect.
