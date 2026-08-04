---
"@mcpjam/sdk": minor
"@mcpjam/inspector": minor
"@mcpjam/cli": minor
---

One number for conformance: a 0–100 score with advice included.

`computeConformanceScore` and per-suite adapters, grounded in the spec's own
doctrine: conformance is defined by RFC 2119 MUSTs, so MUSTs own 95 of the
100 points; SEP-2484 makes SHOULD-level findings warnings rather than
failures, so advice owns the last 5 (SHOULD/RECOMMENDED −2, MAY −1, capped).
`not-applicable` checks leave the denominator entirely — a server without
auth loses nothing — while `could-not-run` checks stay in it as unearned
points. The 95–100 band is reserved for MUST-clean, complete runs, and 100
means every applicable check passed with nothing left to advise. The number
always ships with its denominator and protocol version.

Surfaces: a pooled headline card and per-suite score chips in the
inspector's Conformance panel (readiness warnings are now rendered — they
cost points, so they must be visible), a `Score:` stderr line on all four
CLI conformance commands, `score` on every `ConformanceReport`
(json-summary), and a JUnit `<properties>` block. Also fixes
`ConformanceReport.outcome`/`incompleteReason`, which were declared but
never assigned, so json-summary can finally tell a failed run from an
incomplete one.
