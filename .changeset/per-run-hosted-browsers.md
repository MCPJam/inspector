---
"@mcpjam/sdk": minor
---

Host configs can carry a `browserToolPolicy` for per-run hosted browsers.

Adds the field to the host-config types and teaches the canonicalizer to
normalize it, so an unattended eval or swarm run can be granted browser tools
scoped to that run. The policy never widens on its own: an allowlist with empty
lists normalizes to `undefined` rather than to "allow everything".

Additive for hashing — a host config that omits the field canonicalizes and
hashes exactly as before. The backend re-runs this canonicalizer to verify the
host-config hash it is sent, so deploy a backend built against this SDK version
before any surface writes the new field.
