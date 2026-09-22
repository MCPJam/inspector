# Multi-account OAuth connections

One user, several OAuth accounts, one MCP server. The protocol has no place to
put "which account": a server sees one bearer token per request and cannot tell
you apart from yourself. So the account lives entirely above MCP — each account
is its own connection with its own grant, and the host keeps the map. Servers
are unaware the feature exists, and nothing on the wire changes.

## Gating

Behind the PostHog flag `multi-account-connections-enabled`, which gates the
one write that creates a second connection (`lib/featureGates.ts`, key
`multi-account-connections`) and the "Connect another account" control. Reads,
relabel, set-default and remove stay ungated so a de-flagged org can still see
and take down what it has. Its conditions must stay email-property-only.

Personal OAuth servers support up to eight connections. Connection management is
inside the server card/details: add, reconnect, relabel, change default, and remove.
Shared OAuth servers remain single-account and keep administrator write checks.

## Identity

Each credential row is a stable account identity. Refresh and identity capture use
the vault generation as a compare-and-swap guard. Reauthorization of a known
identity stages a new credential until capture can merge it into the oldest row
with the same exact profile ID. A different identity never receives the old ID.
Shared reauthorization replaces the single row with a new ID.

Identity comes from the server's designated profile tool — the one marked
`_meta: {"openai/profile": true}` — called once per connection with an empty
argument object. The bearer token is the input: the call goes out on that
connection's client, so there is nothing to ask. Dedupe is on the returned `id`
and never on email, because a delegated shared inbox is opened with your own
credentials and honestly reports your own address.

A profile tool is optional. Without one, routing still works — the connection IDs
exist and calls land on the right token — but accounts have no labels, so neither
the user nor the model can tell them apart.

## The selector

Chat exposes a required `link_id` selector when schemas match, or account-specific
variants when they differ or already declare `link_id`. The selector is named to
match what ChatGPT injects, so servers have one reserved argument name to avoid
rather than one per host; `account` is a name a server plausibly owns itself.
Both execution and linked resource conversion use the selected connection. Local
chat uses stable qualified aliases for every account, plus a default alias for
non-chat consumers, so changing the default cannot redirect an in-flight turn.
Hosted managers are per-turn.
Evals and non-chat consumers continue using the default account.

The selector is injected by the host and stripped by the host. It never reaches
the wire, so the server receives exactly the schema it published. A lone
connection gets the bare tool with no injected field at all.

## Observed host behaviour

Measured against the lab with real ChatGPT on 2026-09-20 and 09-21. Dated, not a
compatibility promise — re-measure before relying on any of it. Recorded because
it is what this design was checked against.

ChatGPT solves the problem the same way, and arrived there independently: it
injects an enum-valued `link_id` into the model-facing input schema of every
tool, carrying account labels alongside the allowed values. It appears with two
connections and is absent with one. It is required, and omitting it fails closed
(`link_id must identify an eligible linked account`) rather than falling back to
a default. Injection is driven by connection count; the server never opts in and
cannot opt out. That injection is proven rather than inferred, because the lab's
`whoami` takes no parameters and the lab is ours.

**Fan-out is the model's judgment, and it is not deterministic.** An ambiguous
read may produce one call or one call per connection — the same prompt against
the same two accounts did each on consecutive sessions. The model emits N
separate calls with N different selector values; the host duplicates nothing. Do
not design as though fan-out either will or will not happen.

That carries the sharpest risk in this feature. A tool whose name and description
read as a read, but which writes, gets run on every connection the model chooses
to fan out to — and `readOnlyHint` does not change the model's behaviour. The
safety boundary is server-authored prose, the blast radius scales with connection
count, and because fan-out varies you cannot test your way to confidence about it.

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

The routing decision itself is covered by
`sdk/tests/mcp-client-manager/multi-connection-tools.test.ts`: merge versus
variants, execution and output conversion on the selected connection, selector
rejection, and the tool-name budget. Those are fixtures — they touch no real
credential and no real host.

## Shipped

Backend #1536 and inspector #5367 / #5368 / #5369, 2026-09-21. Backend deploys
first: it adds optional schema fields and connection routes, and existing
authorization consumers receive the old envelope unless they request connection
enumeration.

Inspector #5419 then renamed the injected selector from `account` to `link_id`,
to match ChatGPT and leave server authors one reserved argument name instead of
two. The collision guard is unchanged apart from the name: a server that does
declare `link_id` still gets per-account variants rather than a silently
clobbered field.

## Known gaps

Rerunning an edited tool call from the trace view is disabled for a call that
ran on a specific account: rerun resolves a server, not a connection, so it
would replay through the default credential. Threading the connection through
`tools/execute` is a follow-up.

A full signed-in browser walkthrough and production vault integration have not
been exercised. Unit/integration tests cover their account-management paths.

There is no end-to-end test in this repository, and no verification script in
either repository. Multi-account routing was verified by hand against a lab MCP
server that is its own authorization server — `MCPJam/mcpjam-multiaccount`,
deployed at `https://multiaccount.mcpjam.com` — run out of tree. That repository
is private, so a script in this one could not be run from this one, and it is
gone. An in-repo end-to-end test that starts its own fixture server, and so needs
no network, is the follow-up.

The lab's `create_filter` declares its own `account` argument and existed to
collide with the injected selector. Since #5419 it collides with nothing, so the
variant path has no live fixture against a real server. Restoring it means a lab
tool that declares `link_id`.
