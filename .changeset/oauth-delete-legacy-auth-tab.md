---
"@mcpjam/inspector": minor
---

Delete the legacy Auth tab and the two OAuth implementations only it used.

The Auth tab was reachable by URL but absent from the sidebar and blocked in hosted mode. It was also the only importer of `lib/oauth/oauth-state-machine.ts` (385 lines, one commit in six months) and the only production caller of `refreshOAuthTokens`. Three of the five client-side OAuth implementations existed to serve one unlinked screen — and every one of them was another place the same user action could behave differently.

Removed: `components/AuthTab.tsx`, `lib/oauth/oauth-state-machine.ts`, `refreshOAuthTokens`, the `auth` route and its `AuthRoute` component, and the `auth` app surface.

No replacement is needed. The main connect path never called `refreshOAuthTokens`, and hosted refresh goes through Convex (`server/utils/hosted-oauth-refresh.ts`). If local manual refresh is wanted later, it belongs as an era-parameterized SDK refresh step — not as a revived `fetchToken` + `loadCallbackDiscoveryState` pair, which bypassed every era rule the state machines enforce.
