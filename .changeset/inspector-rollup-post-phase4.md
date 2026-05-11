---
"@mcpjam/inspector": patch
---

Inspector rollup since the last release:

- Chatbox auth: full migration to the org-scoped auth path (Phase E + F).
- Chatbox saves now write through the v2 host-config path; preview auto-connects configured MCP servers before the first turn so the model sees tools on turn one.
- Chatbox NUX: first-run demo auto-seeds, and a fix for the "return to index" navigation after a lost onboarding session.
- Project picker fetches all project servers in one bulk call with stale-while-revalidate, removing the per-project N+1 lookups when switching projects.
- Sentry alert when a project create silently drops servers (regression guard).
- Solo tier removed from the inspector UI and accompanying tests.
- Local chat (unauthenticated chat session) wired up end-to-end.
- 401 responses now consult the cached session before surfacing the error.
- `useEnsureDbUser` hardened so genuine user-creation errors surface instead of being swallowed.
