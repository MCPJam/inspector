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
`deriveOrgProviderKey`. Both rails that derive a key from it — the web chat rail
and the local desktop rail — now refuse the sentinel with a sentence that says
what is actually wrong, instead of asking Convex a question about a model no
provider serves.

The synthetic/swarm classifier answers a different question and gets a different
answer: `resolveSyntheticModelSource` does not refuse the sentinel, it
CLASSIFIES it, returning `external-account` — the label that already means "not
charged to MCPJam, and no configured provider either" — ahead of the key
derivation, with no `orgRuntime` to reuse. That is what lets a session row carry
honest attribution for a turn nobody billed.

Classifying it is not the same as running it, and `resolveTurnRuntime` now says
so out loud: it refuses an `external-account` turn outright rather than handing
back a runnable runtime. Without a harness the sentinel is unrunnable by
construction. WITH one it is unrunnable on that surface specifically — an
external-account runtime authenticates with the customer's own vendor
credential, `runHarnessTurn` takes that credential only from the caller's
materialized project secrets, and `runUnifiedAssistantTurn` (the facade every
caller of the resolver drives) has no `runtimeSecrets` seam at all. Returning a
"hosted + harness" runtime there advertised a turn that then died inside the
harness telling the user to add a `CURSOR_API_KEY` secret they may already have
set. Both refusals land before the caller marks the turn as possibly-spent.

On the public sessions API, which has no harness at all, the refusal moved up to
`assertUnambiguousModelId`, ahead of the turn lease: the lease is what creates
the `chatSessions` row, so failing after it left a session that had run on
nothing.

`resolveHostModelDefinition` also stops asking the org's model config about the
sentinel. Only an enabled provider that LISTS an id can win there and none can
list `cursor/auto`, so on a live external-account turn that call was pure
latency (its lookup carries a 15 s timeout) plus a failure mode, between the
request and the first token.

The same registration gap made the local `/api/mcp/chat-v2` rail send every
Cursor host down the org-BYOK branch, so the harness was never reached — the
preflight would call the host ready and the turn would then fail on a
configuration error. That rail now takes the external-account exemption the web
rail already had, and tags the turn `modelSource: 'external-account'` rather than
`'mcpjam'`, which is what keeps it out of the org's MCPJam spend limit. The same
exemption reaches the bearer mint that branch depends on: it was keyed on "MCPJam
provides this model", so an anonymous Cursor turn arrived at the branch with no
bearer and answered 503 ("Unable to authenticate with MCPJam servers") before the
harness ever started, on a host the preflight had just called ready.

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
sent (a null, empty or whitespace-only id is a 400 before the engine runs and
before anything is persisted).

That authority is scoped to a host that actually carries the SENTINEL, because
the justification is "the host's id is the one honest description of the turn"
and only the sentinel is that. A host whose harness is external-account but whose
model is an ordinary id describes nothing that runs either — Cursor ignores it
and picks its own model — so promoting it over the body would swap one wrong
model id for another. That host is now a refused configuration rather than a
silently mis-attributed run: the shared harness gate (`checkHarnessRuntimeAvailable`
and the dispatch predicate `harnessModelEligibleForRuntime`, which must agree)
rejects an external-account host that pins a model, naming the id it found so its
owner can reset it. Where the two model rules were skipped for external-account
harnesses, this one replaces them — same principle, applied to the arm where the
runtime does the choosing.

Wherever a model label is rendered, the sentinel now reads "Cursor Auto" rather
than the raw id, and the Playground shows it locked with the real reason ("this
host's runtime chooses its own model on your own account") instead of the
sign-in wall it inherited. The id itself is never rewritten: what traces and eval
metadata record is still `cursor/auto`, because the whole point of the sentinel
is that the model is unknown to MCPJam.
