---
"@mcpjam/inspector": patch
---

A session permalink opens the session instead of bouncing to Connect

`https://app.mcpjam.com/sessions?session=<id>&project=<id>` — the link every `/v1/sessions` item carries, and the only URL that opens one conversation — landed a viewer on `/p/<projectId>/servers` with the session id dropped and nothing to say why.

Neither the permalink builder nor the legacy `?project=` normalizer was at fault: the normalizer rewrote the URL correctly to `/p/<projectId>/sessions?session=<id>`, and `SessionsRoute` then threw it away, because the viewer's account resolved `unified-sessions-enabled` to `false`. The route guard bounced the whole visit to Connect.

That flag is a ROLLOUT control over who DISCOVERS the feed — the sidebar item, a bare `/sessions` visit — not an authorization boundary. Row-level visibility is entirely server-side (`canViewSessionInProject`), so honouring a link somebody was handed exposes nothing the flag was protecting, and the route's dark-ship `ErrorBoundary` already covers a deployment whose `sessionsFeed:*` queries are not live yet. The guard now skips the redirect when the URL names a session, and is otherwise unchanged: `/sessions` with no id still bounces for a flagged-out viewer, and the pre-hydration `undefined` window still redirects nobody.
