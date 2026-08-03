---
"@mcpjam/inspector": minor
"@mcpjam/sdk": minor
---

Bring the Conformance tab up to the CLI's capability and make the suites
legible before they run.

**Protocol version is now selectable.** The CLI has taken
`--protocol-version` since it shipped, but the UI had no selector and the
routes dropped the pin entirely: `runProtocolConformance` built its
`MCPConformanceConfig` from URL, token and headers only, so every UI run
adopted whatever the server negotiated — and the OAuth suite silently fell
back to a hardcoded `2025-11-25`. The panel now has an "Auto (negotiated)"
plus per-version dropdown that threads through both the local and hosted
`/protocol` routes into the SDK, and overrides the OAuth profile's version
even when that profile is otherwise empty. Both routes validate the field
with `z.enum(MCP_PROTOCOL_VERSIONS)`, so an unknown pin is rejected before
any routing decision.

**The negative OAuth checks are part of the suite, not an opt-in.** The
"Run negative OAuth checks" toggle is gone and `oauthConformanceChecks` is
always on. Verifying that a server *rejects* an invalid client, a mismatched
redirect URI, an invalid token, and an `http://` DCR redirect is half of OAuth
conformance; gating it behind a switch meant an OAuth section could report a
clean pass while nine checks had never run and were not even rendered as
skipped. The runner still only reaches them once the happy path passes end to
end.

**Tasks conformance now runs on hosted.** It was marked "requires a persistent
connection (run it from the local inspector)", which was never true — the
runner opens its own ephemeral client for the length of the run, exactly like
Apps conformance, which has always worked on hosted. The real gap was a
missing route. Adds `POST /api/web/conformance/tasks` reusing the resolver
Apps already uses. Three bounds keep it inside the 30s hosted call budget: the
poll window is clamped to 20s, each MCP leg (connect, `tools/list`, the
provoking `tools/call`) to 10s, and the run as a whole to 28s — past that the
route answers 504 `TIMEOUT` telling the caller to run it locally, rather than
hanging.

**Suites explain themselves before they run.** Each section is collapsible and,
until a result replaces it, lists the checks it will run with a one-line
description on click. The protocol list is filtered by the pinned version's
era, so a `2025-06-18` pin hides the modern-only checks instead of implying
they apply; on "Auto" everything is listed with the era-restricted rows
tagged.

For that preview the SDK gains `conformance-catalog.ts` — a browser-safe,
dependency-free record of all 47 check titles and descriptions, exported from
the browser entry. The canonical strings live beside the check
implementations, in modules that pull the whole runner graph and cannot be
imported from a bundle, which is why the copy exists;
`tests/conformance-catalog.test.ts` asserts it byte-identical to all eight
canonical sources and exhaustive over the id unions, so the two cannot drift.
