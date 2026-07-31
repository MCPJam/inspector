---
"@mcpjam/sdk": minor
"@mcpjam/inspector": patch
---

Add opt-in support for path-scoped authorization servers to the OAuth Debugger, mirroring the toggle the XAA debugger got in #3049.

Multi-tenant authorization servers such as Scalekit scope their endpoints under a path (`https://<env>.scalekit.cloud/resources/res_x`) while their metadata advertises the origin root as `issuer`. The 2026-07-28 debug state machine enforces RFC 8414 §3.3 with an exact string comparison, so those servers hard-failed discovery with no way to proceed — the same shape the XAA debugger already had an escape hatch for.

The state machines gain an `allowPathScopedIssuer` option (`BaseOAuthStateMachineConfig`), surfaced in the inspector as a "Path-scoped authorization server" switch under the OAuth Debugger's Advanced settings and persisted on the server's OAuth test profile. It is **off by default**: the strict exact-match rejection still fires, and its message now names the toggle so the fix is discoverable from the error rather than only from the docs. Only the 2026-07-28 era enforces the check, so earlier protocol versions are unaffected either way.

Enabling it relaxes exactly one thing — an advertised issuer that is a same-origin path-prefix *ancestor* of the URL discovery started from. The comparison is segment-aware (`/resources` is an ancestor of `/resources/res_x` but not of `/resources-evil`), and cross-origin issuers are still rejected outright. Even under the opt-in, `token_endpoint` and `registration_endpoint` must stay on the advertised issuer's own origin: without that binding, a same-origin tenant — the exact party this feature extends trust to — could advertise the origin-root issuer to pass the prefix check while pointing the token endpoint at an arbitrary public host, redirecting the client secret and authorization code off-origin. Accepting a path-scoped issuer also emits a warning entry in the flow log, since strict MCP clients may still refuse to connect to the server being debugged.
