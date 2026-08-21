---
"@mcpjam/inspector": patch
---

Send the hosted bearer on the registry's Convex routes so the catalog stops 401ing.

Opening Registry on a hosted deployment fired two `Missing or invalid bearer token` toasts and rendered every card with zero stars. The catalog request went out with no `Authorization` header at all — signed in, signed out, or as a guest, the outcome was identical, so it never looked like an expired session.

`authFetch` attaches the hosted bearer only when the request's path matches an entry in `HOSTED_AUTH_PATH_PREFIXES`. Most callers hit same-origin `/api/web/*` and are covered by that prefix; the registry client is one of the few that calls Convex directly at an absolute `https://<deployment>.convex.site/web/registry/...` URL, and `/web/oauth/` was the only `/web/` entry on the list. Every registry route fell through the match and was sent bare. On the other side, `/web/registry/catalog` opens with `ctx.auth.getUserIdentity()` and answers 401 with exactly that message when there is no identity — it needs one to resolve per-viewer `isStarred`, so there is no anonymous read to fall back to.

Adding `/web/registry/` to the list covers all four routes, which share the same helper and had the same defect: `catalog`, `star`, `unstar`, and `merge-guest-stars`. The last one meant a guest's stars were silently dropped instead of merged on sign-in.

This does not widen where credentials can go. A path-prefix match is necessary but not sufficient — `shouldAttachHostedAuthorization` first requires `isHostedAuthAllowedOrigin`, which admits only the app's own origin, a loopback host, or the configured `*.convex.site` hostname. A foreign origin serving the same path still gets nothing, and the accompanying test pins that.

The failure mode is worth naming, because the next direct-to-Convex route will hit it too: a path missing from the prefix list produces no warning and no type error. The request simply goes out unauthenticated and surfaces as a generic 401 from the server.
