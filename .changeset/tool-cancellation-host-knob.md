---
"@mcpjam/sdk": patch
"@mcpjam/inspector": patch
---

Model tool cancellation per era: two Protocol-tab switches and two caniuse rows

A server author has no way to answer the question that decides whether a stopped
turn costs them anything: **when the user hits stop, does the host tell me?** If
it does not, the tool runs to completion server-side — side effects, tokens and
all — while the host has already moved on.

`mcpProfile.toolCallCancellation` now answers it, as
`{ legacy?: boolean; modern?: boolean }` — one leaf per era.

**Two leaves, not one boolean.** A host can be right on one era and wrong on the
other, and the proof is this package's own history: MCPJam sent
`notifications/cancelled` correctly on 2025 while never aborting the stream on
2026. Through the 2026 migration that split is common, and collapsing it hides
exactly the defect the prober exists to find. `legacy` covers every 2025 revision
(they are identical here; `2025-11-25` differs only in routing task-augmented
requests through `tasks/cancel`); `modern` covers `2026-07-28`.

The era selects the leaf, not the transport: a 2026 stdio connection reads
`modern` even though its mechanism is `notifications/cancelled`. What is modeled
is whether the host cancels on that era's connections, not which message carries
it. Users never see `legacy`/`modern` — the UI and caniuse say "Tool cancellation
(2025)" and "(2026)".

Absent per leaf is the conforming answer, so a fully cancelling client writes
nothing and keeps its canonical hash; only an explicit `false` is stored. The
field is validated by the same `canonicalBooleanCapabilityRecord` its sibling
`toolListChanged` already uses, on both sides of the wire.

Both leaves travel to the connection, and the leaf that governs is resolved
AFTER the handshake from `getNegotiatedProtocolVersion()` — the same value the
UI reports — falling back to the configured pin before the handshake lands.
Resolving at config-build time cannot work for an unpinned (`"auto"`) host: the
era does not exist yet, so picking one there makes the other era's toggle
unreachable.

A `false` leaf is enforced by withholding the caller's abort signal from the
request and racing the caller against it locally instead. The signal is the only
thing that reaches the wire, so withholding it withholds whichever mechanism that
era would have used, while the turn still ends promptly for the user. It is
deliberately not implemented by hiding the transport's `hasPerRequestStream`:
that would make a modern connection fall back to POSTing
`notifications/cancelled`, a message no conforming client sends on `2026-07-28`.
The simulated host must be silent, not wrong.

Two fixes fall out of wiring it up:

- `toolCallCancellation` was missing from `CONFORMANCE_PROFILE_KEYS`, so the
  public `HostMcp` ⇄ `mcpProfile` round-trip silently dropped it in both
  directions.
- `isMcpProfileEmpty` did not know the field, so turning an era off on a host
  with nothing else configured collapsed the profile and wrote nothing at all.

**Public rows appear with their data.** caniuse.dev hides any field no published
host has been measured for, rather than showing a column of "Not yet tested" — a
question dressed as an answer. The two eras gate independently, so a 2025-only
measurement never publishes a 2026 row nobody has probed. No host values ship
here, so neither row is visible yet.

The saved value has to reach a connection that is already up, and it does so
twice over:

- **Per turn.** The chat routes (local and hosted) resolve the host config
  server-side on every turn and pass its cancellation record to
  `getToolsForAiSdk` as a per-turn override that takes precedence over the
  connection's connect-time copy. It is authoritative whenever a host config
  resolved: a host that cancels normally sends an *empty* record, not nothing,
  because `undefined` would fall through to the stale connection copy and a
  toggle switched back on would keep suppressing.
- **On save.** The host's connected servers are reconnected so the connection's
  own copy is refreshed too — the same reason the per-server protocol pin
  reconnects after its save. The reconnect is deferred until the app's view of
  the host shows the just-saved config: it builds its connection defaults from
  the active host's profile, and right after the mutation resolves that
  subscription still holds the previous config, so an immediate reconnect
  applied the value the user had just replaced — one save behind, every time.
  Narrow by construction: only when the setting actually changed, only for
  servers already connected, never interactive, and a failed reconnect warns
  rather than failing the save.

A suppressed call also outlives the default request timeout. The protocol layer
runs the same cancellation on a timeout as on an abort — closing the stream on a
modern connection — so with the 60s timer left in place a host configured never
to cancel still cancelled, a minute later, which read as the knob being flaky
rather than off. Suppressed requests now carry a long bounded timeout instead.
