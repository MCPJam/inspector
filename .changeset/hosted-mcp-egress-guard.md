---
"@mcpjam/inspector": patch
---

Put every hosted MCP connection behind the DNS-pinning egress guard.

`MCPClientManager` falls back to `globalThis.fetch` when neither the manager
options nor the server config carries a `baseFetch`. Six hosted construction
sites each decided that independently and five decided nothing, including
`createAuthorizedManager` — the factory behind every `/api/web/*` MCP
operation. So a caller could store a server URL, ask the hosted backend to
connect, and have it dial with no address classification and follow redirects
with nothing checking where they landed. `/servers/validate` had no egress
check of any kind, and `/servers/doctor` judged only the URL it started from.

All six now pass `hostedMcpBaseFetch()` — one place that decides what a hosted
MCP connection dials, built on the same pinned transport the conformance and
readiness lanes have used since the seam existed: resolve once, refuse the
disallowed answers, pin the surviving address into the socket, re-run on every
redirect hop. The doctor's probe moves onto it too, retiring the last
double-resolve caller in the tree.

Two things beside the wiring. A hosted doctor failure that never received an
HTTP response now reports one uniform message instead of the socket's own text,
so `ECONNREFUSED` on a closed port and a TLS record error on an open one are no
longer distinguishable — that differential was the port scanner, not the
response bodies. And `/servers/doctor` and `/servers/validate` carry a
per-credential ceiling with a per-address backstop on both `/api/web` and their
`/v1` twins; the only limiter on those routes returned early for anyone who was
not a guest.

Local and desktop behaviour is unchanged. The guard, the redaction and the
limiter are all no-ops outside hosted mode, because `routes/web/**` is mounted
on the desktop app too and reaching `http://localhost:3000/mcp` there is the
product.

Also: `ENVIRONMENT=production` now resolves to the `prod` environment. It was
being discarded by the allowlist and the answer was coming from the `NODE_ENV`
fallback — correct by accident, logged as "ENVIRONMENT not set", and it left
`ENV NODE_ENV=production` in the Dockerfile deciding which platform MCP worker
production dials.
