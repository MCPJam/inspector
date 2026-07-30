---
"@mcpjam/sdk": minor
---

feat(oauth): two catalog-derived server-obligation checks — `registration_endpoint` advertisement (S13) and discovery tolerance of a stale `MCP-Protocol-Version` (S16) (HP-47)

Extends `sdk/src/oauth-conformance/checks/oauth-server-obligations.ts` with the two highest-value obligations from HP-47's S1–S17 enumeration. Both are opt-in behind the existing `oauthConformanceChecks` flag.

**`oauth_as_registration_endpoint` (S13)** asserts that the discovered authorization
server metadata advertises an absolute `registration_endpoint` (RFC 7591 / RFC 8414).
HP-47 measured this as the single highest-frequency real-world failure across the
client catalog, and it is enforced independently by three clients that were read at
the source: Cline (no hardcoded `client_id` exists anywhere in its repo), n8n, and
Codex (DCR-first with no pre-registered path). For those clients a server whose AS
omits the endpoint is not degraded — it is unreachable.

This also closes a reporting hole. `runDcrHttpRedirectUriCheck` reads
`registration_endpoint` only to return `status: "skipped"` when it is absent, so
until now the catalog's most common failure surfaced as a skip, which reads like
coverage in a report. That skip is correct on its own terms — there is no endpoint to
POST a bad `redirect_uri` to — and stays; the new check reports the real problem
alongside it at error level.

Three grading decisions are load-bearing rather than stylistic:

- **Absent vs. malformed are graded differently.** A missing key means the server
  does not offer the capability; a relative, empty, or unparseable value means the
  server *claims* DCR and publishes an address no client can POST to. The latter is
  a defect in the published document under RFC 8414 §2 and fails unconditionally.
- **Absent fails only when DCR was the strategy under test.** On a CIMD or
  pre-registered run the obligation still reports — the catalog-level finding must
  not vanish — but as a `warnings` entry on a passing step. The run demonstrably
  completed without DCR, and failing it would turn every CIMD/pre-registered
  conformance run red against a server that is fully conformant for the path
  actually exercised. The conformance verdict stays about the flow under test.
- **The check runs OUTSIDE the runner's green-flow gate.** Every other post-flow
  check requires `currentStep === "complete"` and a clean step list, which is right
  for probes that tamper with a working flow. It is backwards here: a missing
  `registration_endpoint` is frequently the very reason a DCR run failed, so gating
  on success would guarantee silence in exactly the runs the check explains. This is
  safe because the check issues no HTTP request at all — it reads
  `state.authorizationServerMetadata`, which discovery already populated — and
  because it is appended after the flow steps, so `buildSummary` (which quotes the
  *first* failed step) still headlines the real root cause.

**`oauth_discovery_stale_protocol_header` (S16)** re-requests a discovery document
that already succeeded during the flow — preferring the protected-resource metadata
URL, falling back to the AS metadata URL recovered from the request history — and
changes exactly one thing: it sends `MCP-Protocol-Version: 2024-11-05`.

That literal is not an arbitrary stale-looking revision. It is what `rmcp`, the Rust
MCP SDK, hardcodes on OAuth **discovery** requests specifically, while negotiating a
much newer revision on MCP traffic — which makes it the live behavior of both Codex
and Goose. The finding is invisible from any vendor documentation and was only
recoverable by reading the dependency. A server that gates its `/.well-known/*`
responses on the protocol header works perfectly against every TypeScript-SDK client
and breaks every `rmcp`-based one, so it is unusually easy to ship unnoticed.

The probe passes on a 2xx that still carries the document's identifying field
(`resource` for PRM, `issuer` for AS metadata) and fails on a non-2xx or on a 2xx
whose body has lost it — the exact break `rmcp` clients hit. A *stable identifier* is
compared rather than the whole body because servers legitimately vary other fields
between two fetches; a changed identifier passes with a warning, since the endpoint
still serves something parseable. Request headers mirror the flow's own discovery leg
via `mergeHeadersForResourceMetadataRequest`, so the protocol header is genuinely the
only variable and a user-supplied `Authorization` still never leaks cross-origin.

Adds 16 tests covering pass/fail/skip for both checks.
