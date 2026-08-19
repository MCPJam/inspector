---
"@mcpjam/inspector": patch
---

Name the revoking user when an API key's org binding is removed.

The binding delete used to arrive at the backend carrying nothing but the key
id, so the audit row it writes had to infer an actor — and the only identity
the row carries is the user who minted the key, which is not necessarily the
one revoking it. The revoke handler now resolves the caller's MCPJam user and
sends it as `actorUserId`. That is the Convex document id, not the WorkOS
`sub`; the backend validates it as such.

An unresolvable caller sends nothing rather than failing: by that point the
WorkOS key is already destroyed, and the backend records the revocation as
explicitly unattributed instead of naming someone who may not have done it.
The session's existing ownership check remains the authorization — this is
attribution, and defense in depth on a route reachable with the service token
alone.

Minting also stops flattening one backend answer into a bad one: a key id
already bound to a different organization now surfaces as `409 CONFLICT`
instead of `502`. The backend refuses to re-point a live key into another org,
and that refusal is a conflict, not an unreachable service.
