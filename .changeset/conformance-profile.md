---
"@mcpjam/sdk": minor
"@mcpjam/cli": patch
"@mcpjam/inspector": patch
---

Add a conformance PROFILE so two scores are comparable by construction.

A protocol conformance result recorded `protocolVersion` and its check list and
nothing else, which made two runs from two builds incomparable for two
independent reasons: the denominator floats with the server's advertised
surface, and the check inventory grows. Adding a MUST check is the right
response to reading the spec more carefully, but it silently re-grades every
server that was previously green — the score moved because we learned
something, not because the server changed, and nothing in the result could
separate those.

`MCPConformanceResult.profile` now stamps which questions the run asked: the
frozen manifest of SCORED check ids (`profileId`/`profileVersion` plus a digest
over the manifest), the checker version, the revision judged against, and a
slot for the wire-schema digest. A check outside the manifest still runs and
still shows its real verdict in the report, but it lands in the new
`ConformanceScore.pending` bucket — excluded from `applicable`, from the
pass/fail tallies, and from the verdict. Promoting it to scored is a profile
version bump, which is a reviewable act rather than a side effect of merging a
check.

`mcp-protocol@2026-08-21.1` is frozen at exactly today's 36 checks, so this
release moves no score. The stamp carries its own `pendingCheckIds`, so a
stored report partitions the same way for any reader — including a build that
never heard of the profile version that produced it. A result without a stamp
has no pending bucket at all, which is the pre-profile arithmetic exactly.

The CLI prints the profile line under the score; `describeConformanceScore`
names the pending count, so every surface that renders it picks that up.
