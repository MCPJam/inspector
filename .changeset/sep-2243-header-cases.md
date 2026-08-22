---
"@mcpjam/sdk": minor
---

Cover the SEP-2243 header cases the mismatch checks never reached.

Our modern pool asserted three header MISMATCH rejections and nothing else, so
two distinct requirements went untested: a required standard header that is
absent rather than wrong, and the rule that header names are compared
case-insensitively.

`modern-missing-method-header-rejected` (MUST) omits `Mcp-Method` from an
otherwise well-formed `server/discover` and requires HTTP 400 with JSON-RPC
`-32020`. The spec lists a missing standard header as a validation-failure
condition alongside a mismatched one and states the same remedy for both, so
both halves are asserted at MUST strength, like the sibling mismatch checks.

`modern-header-names-case-insensitive` (MUST accept) sends the standard headers
under deliberately mixed casing and requires the server to answer normally. It
works through the ordinary guarded transport because Node's fetch preserves the
header-name casing it is handed on the wire — only `Headers` *iteration*
lowercases, which is a red herring.

The missing `MCP-Protocol-Version` case is **advice, not a check**. The same
spec section grants an explicit escape hatch: a server supporting
pre-2025-06-18 clients "MAY treat a request that omits the header as protocol
version 2025-03-26". Nothing on the wire says which kind of server it is, and
the official server SDK answers such a request normally — so a check demanding
rejection would fail conforming servers. It is reported as
`readiness-protocol-version-header-required` (SHOULD) instead.

Optional whitespace around header values (RFC 9110 `field-line = field-name ":"
OWS field-value OWS`) is **not** covered, on purpose. `Headers.set` normalizes
the value before it reaches the socket, so sending OWS would need a raw-socket
transport — which would bypass `config.fetchFn`, the SSRF guard every probe in
this suite deliberately dials through. The gap is recorded in the check's
docstring rather than closed by trading away a hosted-mode network guard.

Both checks land in the `pending` bucket and move no score.
