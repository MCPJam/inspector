---
"@mcpjam/inspector": patch
---

Make the Sessions tab reachable on the hosted app.

The unified Sessions feed shipped with its nav item, route, and
`unified-sessions-enabled` flag wiring all in place, but `"sessions"` was never
added to `HOSTED_SIDEBAR_ALLOWED_TABS`. On hosted deployments the sidebar builds
from `getHostedNavigationSections`, which drops any item whose segment is not on
that list — and it runs *before* the feature-flag filter. So flagged-in users on
app.mcpjam.com saw no Sessions item, and a direct `/sessions` URL fell through to
Servers via the same policy in `App.tsx`.

Nothing about the feed is hosted-specific: it reads the Convex-backed session
rows the hosted surfaces already write. Adding the one entry restores parity
between hosted and local, and `HOSTED_HASH_ALLOWED_TABS` picks it up because it
spreads the sidebar list. Visibility is still governed by the PostHog flag —
this only makes the tab reachable.
