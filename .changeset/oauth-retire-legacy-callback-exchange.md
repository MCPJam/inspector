---
"@mcpjam/inspector": minor
---

Retire the legacy callback token exchange, and give `clearOAuthData` ownership of the pending marker.

`handleOAuthCallback` branched on whether a stored flow session existed: with one, the era state machine redeemed the code; without one, a second complete implementation rediscovered metadata and called `exchangeAuthorization` directly. That is how the same user action took two different code paths — prod and staging shipped byte-identical code and behaved differently — and the legacy path was era-blind. It skipped the era machine and with it the callback-state checks the machine performs, the resource binding, and the issuer policy, so each of those protections had to be re-implemented and separately tested on the fallback.

The fallback is gone. A callback with no stored flow session now clears the pending marker, records `oauth_callback_no_session_recovery`, and returns an explicit "please connect again to reauthorize" — it makes no token request at all. A session that straddles a deploy will land here, and a clear reauthorization is strictly safer than redeeming a code without the protections the current era requires.

The branch was reachable because `clearOAuthData(serverName)` cleared every per-server key but never the global `mcp-oauth-pending` marker, leaving a server name with no session behind it. `clearOAuthData` now owns the full key list, and removes the global marker **only when it names the server being cleaned** — the marker is global, so cleanup for one server must never strand another server's in-flight authorization (a real two-tab shape). A test enumerates every `mcp-*` key an OAuth flow writes, so a new key has to be added to the cleanup too.

Five tests that each defended one protection on the retired path are replaced by one that asserts every such shape now asks for reauthorization and redeems nothing.
