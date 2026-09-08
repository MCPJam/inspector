---
"@mcpjam/inspector": patch
---

Eval runs now connect as the host they execute under

An eval run's MCP connection took its `initialize` pins from whichever client
was ACTIVE in the browser at launch — protocol version, client identity,
advertised capabilities, pagination traversal and the other conformance knobs
all rode the request body, and the body was built from the playground's current
selection. Tool visibility, meanwhile, already resolved server-side from the
run's own host. So a suite fanned out across environments could take its tool
visibility from one client and its protocol version from another, and switching
the playground client changed how an unrelated suite connected.

Every eval launch path now resolves the host the run executes under and
connects as that host: `/api/web/evals/run`, `/run-test-case`,
`/stream-test-case`, and the v1 `POST /projects/{id}/eval-runs` and
`/eval-run-groups` routes. The v1 paths sent no pins at all before, so a suite
pinned to a protocol version or to first-page-only pagination ran as a default
client that matched nothing its settings page claimed.

The host is authoritative: its pins REPLACE the body's rather than merging with
them, because every field the browser sends is derived from the active client —
a per-key merge would leave the drift wherever the run's host happened to be
silent. The conformance knobs keep their existing overlay semantics (they are
suppression switches, so a host that wants the full behavior removes a body pin
rather than not setting one). A request that names no host is unchanged.

Also: the run's host request timeout and its per-server timeout overrides now
apply where they previously did not, and the v1 launch reads its
enterprise-managed authorization policy from the run's host instead of never
enforcing one.

`buildPinnedConnectionSettings`, which the swarm launcher already used to
reconnect with a pinned snapshot's settings, moved to
`services/host-connection-pins.ts` and is now shared. Swarm behavior is
unchanged.

NOTE: an environment whose client has been deleted now fails the launch with a
404 naming that client, instead of silently running as the default MCPJam host.
The run-group route already behaved this way for its harness gate.
