---
"@mcpjam/sdk": patch
"@mcpjam/inspector": patch
---

Fix Cursor's MCP Apps matrix disagreeing with the host catalog.

`MCP_APPS_CURSOR` is a hand-maintained mirror of the catalog's Cursor row, and
two keys had fallen out of sync: it pinned `downloadFile: false` where the
catalog says `true`, and inherited `requestTeardown: true` from `MCP_APPS_FULL`
where the catalog says `false`. The catalog corrections landed without the
mirror being updated.

The two are read by different consumers — the Playground emulation resolves
from this matrix, `mcpjam compat` grades from the catalog — and `downloadFile`
is one of the keys the compat evaluator grades. So the Playground showed a
Cursor widget's file download failing while the compat report said Cursor
supports it.

Nothing enforces agreement between the two sources today; this is the value fix
only.
