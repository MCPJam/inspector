---
"@mcpjam/inspector": patch
---

Fix the server card's **Reconnect** action forcing an OAuth flow on servers
that have no OAuth at all.

The kebab-menu Reconnect decided whether to force a full re-authorization from
`server.useOAuth === true || server.oauthTokens != null`. That predicate dates
back to when `useOAuth` meant "the user chose OAuth", but unauthenticated-first
Auto (#3198) made it also true for Auto servers: an Auto server that connects
*unauthenticated* still gets `useOAuth: true` stamped on it as a derived
mirror. Auth defaults to Automatic in the add-server form, so this covers most
plain HTTP servers.

The result, for a server with no authorization server at all: Reconnect took
the `forceOAuthFlow` branch, which clears stored OAuth data, deletes the
connection, flips the card to "Authorizing in browser...", and starts an
interactive OAuth flow that then fails. The on/off toggle was unaffected — it
only ever *allows* OAuth, so it reached the orchestrator's Auto guard and
connected normally.

Reconnect now mirrors that same guard and skips the forced flow for a tokenless
Auto server, so it plainly reconnects. Everything else is unchanged: explicit
OAuth servers, and any server already holding tokens (including Auto ones that
did authorize), still force a fresh flow, and a real 401 still escalates
through the existing user-confirmed prompt.
