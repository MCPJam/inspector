---
"@mcpjam/inspector": patch
---

Replace the hosted-mode tab allow-list with a block list derived from the surface manifests.

`hosted-tab-policy.ts` was written when hosted mode was a small subset of the
desktop app, and it never stopped being default-deny: every new tab had to be
added to `HOSTED_SIDEBAR_ALLOWED_TABS` by hand, and one that nobody remembered
was simply absent on app.mcpjam.com — no error, no flag that could bring it
back, because the sidebar filter runs before `filterByFeatureFlags`. That is how
Sessions shipped invisible (#4210), and the file had taken 37 commits of
catch-up edits before it.

The premise had inverted: of ~30 nav segments exactly one, Tracing, genuinely
cannot run hosted (it needs the local OTLP collector). So the allow-lists and
their two predicates are gone. `hostedBlocked` in `shared/app-surfaces.ts` — a
field that already existed and already drove the agent atlas — is now the single
source of truth, exposed as `listHostedBlockedNavSegments()`, and
`isHostedTabBlocked()` is the one availability check the sidebar, hash/route
resolution, and `ui_navigate` all share. `ui-actions.ts` already worked this way.

Behavior change: a new tab is reachable on hosted the day it lands, with its
feature flag deciding visibility. The sidebar/hash split disappears with the
allow-lists; it only ever differed on `computer` and `skills`, neither of which
is a sidebar item.
