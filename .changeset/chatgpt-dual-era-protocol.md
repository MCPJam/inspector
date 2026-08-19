---
"@mcpjam/sdk": minor
"@mcpjam/inspector": minor
---

Claude and ChatGPT speak two protocol eras, and a host's protocol selection can
say "negotiate" instead of naming a revision.

Both catalog rows now list `["2025-11-25", "2026-07-28"]` as supported and are
marked `provenance: "probe"` — captured from the real clients rather than
assumed or read off a vendor page. The same capture corrected details that were
guessed before: ChatGPT and Claude do not honour `requestTeardown`, Claude's
available display modes are inline and fullscreen (no PiP), Cursor's are inline
only, and every MCP Apps row now carries explicit `cspConnectDomains` and
`cspResourceDomains` sets instead of leaving them unstated.

## `mcpProtocolVersion: "auto"`

`mcpProfile.mcpProtocolVersion` accepts `"auto"` alongside the concrete
revisions. It is a **stored selection policy, never a wire literal**: nothing
puts the string on a request. `resolveEffectiveMcpProtocolVersion` and
`hostConnectionProfile` both collapse it to `undefined`, which is exactly what
an unpinned host resolved to before, so connect behaviour is unchanged for
every existing row.

The distinction it buys is between "this client negotiates, deliberately" and
"this field was never set". Legacy rows keep the absent field and keep saving;
the dual-era presets ship `"auto"` explicitly, so a client whose default is
negotiation says so in its own config instead of being inferred from a hole.
Absent still canonicalizes to absent, so pre-feature rows continue to hash
identically.

`ConflictingProtocolVersionPin` is now stated the way it actually behaves: a
stateful pin must appear in `initialize.supportedProtocolVersions` (and derives
that list when the caller sent none), while a stateless pin skips the
handshake entirely and is exempt from the accept-list check. Hosts saved with a
stateless pin outside their list predate this work and must keep saving.

## Inspector

The Protocol tab's dropdown offers the union of the client's `initialize`
accept-list and the eras its catalog row advertises. The handshake list only
ever carries legacy revisions, so reading it alone made `2026-07-28`
unselectable on the very clients that speak it. A row with no accept-list is a
legacy row and stays fully editable — the catalog only widens an existing list,
never creates one. Selecting Automatic now writes `"auto"` rather than deleting
the field, and the JSON editor round-trips it.

The unadvertised-pin warning fires for stateful pins only, matching the rule
above: warning on a stateless pin promised a Save failure that never came.

Can-I-use gains a Protocol versions row. It reads the catalog's supported list
rather than the preset's handshake list, so the matrix reports what each client
speaks instead of what it happens to advertise during `initialize`. It renders
as a plain value, not a support chip — "which eras" is not a yes/no question.
