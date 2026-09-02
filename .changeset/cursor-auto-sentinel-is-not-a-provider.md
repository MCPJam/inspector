---
"@mcpjam/inspector": patch
---

A Cursor CLI host no longer asks for a model-provider key that cannot exist, and its sessions record the model they actually ran

The `cursor-cli` host template seeds `modelId: "cursor/auto"` — a neutral
sentinel, deliberately not a real provider model. The Cursor CLI has no provider
routing: it authenticates with a `CURSOR_API_KEY`, every request transits
Cursor's servers, and the adapter passes no model at all, so Cursor Auto picks
one on the customer's own account. Seeding a concrete `anthropic/...` was
rejected precisely because it would put a model id into traces and eval metadata
that nothing ever ran.

Registering `cursor` as a `ModelProvider` — which is what stops the sentinel
falling through the bare-id rule and classifying as `ollama` — had a second
effect nobody asked for: every path that resolves a model through provider
configuration started treating it as a BYOK provider needing a configured org
key. A turn sent as `model: "cursor/auto"` came back
`provider_not_configured: cursor is not enabled for this project/workspace
organization`, which reads as a setup mistake the customer could fix. They
cannot; there is no `cursor` key to configure, and there never will be.

The sentinel is now exempted from provider resolution at one chokepoint,
`deriveOrgProviderKey`, so all three derivation sites (the web chat rail, the
local desktop rail, and the synthetic/swarm classifier) refuse it with a sentence
that says what is actually wrong instead of asking Convex a question about a
model no provider serves. `resolveSyntheticModelSource` classifies it
`external-account` — the label that already means "not charged to MCPJam, and no
configured provider either" — and `resolveTurnRuntime` maps that to the hosted
runtime shape carrying only the harness, never a `providerKey`. On the public
sessions API, which has no harness at all, the refusal moved up to
`assertUnambiguousModelId`, ahead of the turn lease: the lease is what creates
the `chatSessions` row, so failing after it left a session that had run on
nothing.

The same registration gap made the local `/api/mcp/chat-v2` rail send every
Cursor host down the org-BYOK branch, so the harness was never reached — the
preflight would call the host ready and the turn would then fail on a
configuration error. That rail now takes the external-account exemption the web
rail already had, and tags the turn `modelSource: 'external-account'` rather than
`'mcpjam'`, which is what keeps it out of the org's MCPJam spend limit.

Separately, a successful Cursor turn persisted a session that named the wrong
model, or none. The Playground picker cannot hold `cursor/auto` (it is not a
selectable entry, so the host-reseed effect skips it), and the host-model
override was gated on scenario turns only — so the browser sent whatever model
was last selected and the server recorded it verbatim, attributing the turn to a
model Cursor never touched. Where the body carried no usable id at all, the row
was written blank and the session read as having run on nothing: the harness rail
is the one live path with no downstream model-id check, since it skips both the
provider-key derivation and the harness model gates by design. The host's model
is now authoritative for an external-account harness on every surface — the
runtime ignores the body's model, so the sentinel is the only honest record — and
the chat route validates the model's `id`, not just that a `model` object was
sent.

Wherever a model label is rendered, the sentinel now reads "Cursor Auto" rather
than the raw id, and the Playground shows it locked with the real reason ("this
host's runtime chooses its own model on your own account") instead of the
sign-in wall it inherited. The id itself is never rewritten: what traces and eval
metadata record is still `cursor/auto`, because the whole point of the sentinel
is that the model is unknown to MCPJam.
