---
"@mcpjam/sdk": minor
"@mcpjam/inspector": patch
"@mcpjam/cli": patch
---

Make the OAuth conformance verdict honest, per protocol version.

The resource-metadata check is now version-sensitive the way the spec is:
2025-06-18 states a flat MUST for the WWW-Authenticate `resource_metadata`
parameter, so its omission still fails there — but 2025-11-25 and 2026-07-28
name TWO sanctioned discovery mechanisms, so on those revisions the check
probes the RFC 9728 well-known URIs (path-scoped first, then root) before
judging, and a server publishing metadata there passes with a note instead of
failing. A well-known 200 must actually BE protected-resource metadata
(carry the RFC 9728 `resource` member): an SPA answering every path with its
index page does not count. A present-but-relative `resource_metadata` stays
a violation everywhere the mechanism exists.

The OAuth runner also adopts the shared verdict vocabulary, closing the last
suite where "nothing failed" could read as "passed" over steps that could
not run: `OAuthRunOutcome` gains `"incomplete"` (with `incompleteReason`),
the CLI exits 3 for it like every other suite, the human formatter prints
INCOMPLETE/INC, suite `passed` requires every flow to pass or be
inapplicable, and the inspector badges it amber. Skipped steps without a
could-not-run reason keep their existing verdicts, so current flows are
unaffected.
