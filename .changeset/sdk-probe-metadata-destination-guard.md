---
"@mcpjam/sdk": patch
---

Guard the OAuth metadata destinations the probed server chooses.

`probeMcpServer` fetched two URLs it took on trust from the server under test: the RFC 9728 `resource_metadata` pointer in the `WWW-Authenticate` challenge, and the `authorization_servers[0]` entry in the document that pointer returned. Neither was checked before the request went out, and requests follow redirects, so a hostile or misconfigured server could steer up to four outbound fetches at any destination it named — including cloud instance metadata at `169.254.169.254` or a service on the private network. The probe already stripped `Authorization` from metadata fetches, so credentials never leaked; the gap was the destination.

That matters because the probe does not only run locally. `runServerDoctor` reaches it from the hosted Hono backend, on a route that allows guests, so the requests originate from MCPJam infrastructure.

Both hops now go through `assertOutboundOAuthUrlAllowed`, the same RFC 6890 guard the OAuth state machines already apply to every request. A blocked destination is reported as `discoveryError` on the probe result rather than thrown, so the probe still returns `oauth_required` with everything it did learn, and the second hop keeps the protected-resource document it already fetched.

The guard would break real usage if applied naively, so it carves out the origin the caller pointed the probe at: an http(s) metadata URL whose scheme and host match the configured server URL is always allowed, whatever address tier it is on. Scheme and host, not `URL.origin` — every non-special scheme reports the origin `"null"`, and `blob:https://host/…` reports the origin of the URL it wraps while having no host of its own, so an origin comparison let a `blob:` pointer at the server's own origin skip the guard. That keeps loopback and LAN-hosted MCP servers discovering their own metadata. Cross-origin destinations get the shared guard, with the loopback opt-in derived from the server URL — so a local server may hand off to an authorization server on another loopback port, while a public server can never reach the user's loopback. Tests pin every one of those cases, including a LAN server, since the carve-out is what a future tightening would most plausibly regress.

Redirects are covered too: `performRequest` now reports the URL a response actually landed on, and metadata fetches re-check it before reading the body. As with the browser executor's final-URL revalidation, this refuses to consume the response rather than preventing the request.

This bug predates the 403 challenge work — the previous regex-based parse fetched the same unvalidated URL — but that change widened the trigger, since a 403 now reaches discovery where only a 401 did before.
