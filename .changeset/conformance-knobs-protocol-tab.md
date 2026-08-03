---
"@mcpjam/inspector": minor
---

Add host-editor controls for the two client-conformance knobs, beside the
existing SEP-2243 mirroring control: **Paginated list traversal** (walk every
page / first page only) and **Multi-round tool results** (supported / not
supported).

Both follow the mirroring knob's discipline — picking the default writes
ABSENCE rather than the literal, so a host that merely opens this tab keeps
its canonical hash (and, since host configs are content-addressed, does not
mint a new row). Unknown literals hand-edited into the JSON view collapse to
the default instead of reaching the canonicalizer, which throws and would
reject the user's whole save.

The profile-collapse check that decides whether an `mcpProfile` is worth
persisting is now a single `isMcpProfileEmpty` helper. It had been inlined at
three write sites, which meant every new profile field had to be added in
three places or a profile carrying only that field would silently collapse,
losing the setting on save.
