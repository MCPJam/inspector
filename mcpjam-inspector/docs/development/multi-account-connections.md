# Multi-account OAuth connections

Personal OAuth servers support up to eight connections. Connection management is
inside the server card/details: add, reconnect, relabel, change default, and remove.
Shared OAuth servers remain single-account and keep administrator write checks.

Each credential row is a stable account identity. Refresh and identity capture use
the vault generation as a compare-and-swap guard. Reauthorization of a known
identity stages a new credential until capture can merge it into the oldest row
with the same exact profile ID. A different identity never receives the old ID.
Shared reauthorization replaces the single row with a new ID.

Chat exposes a required `account` selector when schemas match, or account-specific
variants when they differ or already declare `account`. Both execution and linked
resource conversion use the selected connection. Local chat uses stable qualified
aliases for every account, plus a default alias for non-chat consumers, so changing
the default cannot redirect an in-flight turn. Hosted managers are per-turn.
Evals and non-chat consumers continue using the default account.

Deploy the companion backend branch before the inspector branch. The backend adds
optional schema fields and connection routes; existing authorization consumers
receive the old envelope unless they request connection enumeration. No production
deployment is performed by this implementation.

## Verification

- SDK: 547 focused readiness, profile, routing and OAuth conformance tests.
- Inspector: 461 focused client, route, chat, refresh, continuation, harness and eval tests.
- Backend: 28 credential, connection and generated registry tests.
- SDK build/typecheck, client/backend typechecks, design and mirror checks pass.
  Server typecheck has existing errors; comparison against the base checkout found
  no additional diagnostics.
- An isolated local Convex deployment passed live connection insertion, default
  switching, stale-delete rejection, reconnect, merge and default promotion checks.
  All six connection HTTP routes rejected unauthenticated requests.
- `node sdk/scripts/verify-multi-account-lab.mjs` exercises real DCR/PKCE grants,
  same-email distinct profiles, account-specific linked-resource conversion,
  upstream selector collisions, invalid selector rejection, token refresh and
  live profile conformance checks. It expects the multi-account lab on port 18811
  (override `MULTI_ACCOUNT_LAB_URL`) with `linked_resource` and `upstream_account`
  tools. The isolated lab copy is `/private/tmp/mcpjam-multi-account-lab`.

A full signed-in browser walkthrough and production vault integration have not
been exercised. Unit/integration tests cover their account-management paths; the
live lab and local backend checks run separately.
