---
"@mcpjam/inspector": patch
---

Readiness sections need no flag of their own

`/conformance` is already gated by `mcpjam-conformance` — the sidebar filters
the nav item and, more to the point, `App.tsx` redirects the route away unless
the flag reads `true`. Nobody without it can reach the page at all, so a
second flag on two sections inside that page gated an audience against itself.

The cost was not theoretical: the sections shipped invisible, waiting on a
flag that had to be created before anyone could see the feature that had
already merged.

Removed rather than switched to `mcpjam-conformance`, because the check adds
nothing over the gate that already ran. A flag can be reintroduced in one line
if readiness ever needs to lag the page — deleting one later is the harder
direction, and this one had no consumers.
