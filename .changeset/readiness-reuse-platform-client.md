---
"@mcpjam/inspector": patch
---

Readiness: use the platform client instead of a second copy of it

The /conformance page's hosted half hand-rolled five request wrappers, a
request/parse/error helper, and a field-by-field body build for the start
routes — all of which `PlatformApiClient` already does, with typed parameters
and a timeout the copy did not have.

The body build is the part worth naming. The start routes are `strictObject`,
so an unknown key is a 400 rather than an ignored extra, and a rejected start
never reaches its idempotency key — meaning the retry dedupes against nothing
and dials somebody's server twice. The SDK client has `pickReadinessStartBody`
for exactly that. The copy re-derived the same rule from the same reasoning,
with its own comment explaining it, unaware the original existed. Two
implementations of one wire contract drift, and the one nobody is looking at
drifts first.

`sdk/src/platform` is CI-guarded against `node:` imports and `process.env` on
both source and dist, so a browser can use it — which is what that guard is
for.

One wrinkle worth keeping: the client sets its own `authorization` header, and
`authFetch` reads a caller-provided Authorization as "this caller owns its
auth" and skips both its own header AND its refresh-and-retry on 401. Passing
the client straight through would have quietly cost the session self-healing
every other hosted call has, on the one surface that polls for minutes. The
transport strips the header on the way out so the bearer has exactly one
owner.

The local half stays hand-written: it is one synchronous, free, unpersisted
call to `/api/mcp`, which no platform client speaks.

Net 54 lines lighter, and the run row and receipt are now the platform's types
rather than a restatement of them.
