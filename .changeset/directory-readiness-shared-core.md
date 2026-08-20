---
"@mcpjam/sdk": minor
---

Extract the publisher-agnostic readiness result algebra into `sdk/src/directory-readiness/`.

`claude-readiness` was written as one publisher's product, but only its
REQUIREMENTS are Anthropic's. How a requirement is graded — a finding cites a
source, declares provenance, names the capabilities it needed and is dispositive
or not; a lane rolls its findings up; coverage is reported separately from
verdicts — is the same for any directory. A second publisher would have copied
that algebra, and the first thing to drift would be the rule that keeps the
product honest: "did not run" must never read as "conformed".

The algebra now lives once, generic over `<Lane, SourceRef, Capability>`:

- `decideLaneStatus`, `rollUpLaneStatus`, `summarizeLaneCoverage`,
  `isDispositiveDirectoryFinding`, and `enforceCapabilityGate` (promoted from
  private in `claude-readiness/runner.ts`).
- `createFindingConstructors({ engineVersion })`, which binds the engine version
  once per publisher instead of trusting each call site to pass the right one.
- A `DirectoryReadinessReportProvider` descriptor in `conformance-reporting`, so
  the readiness renderer takes the provider's own result predicate and
  dispositive policy rather than assuming Anthropic's.

Claude's public API is unchanged: every exported name keeps its signature, and
the whole existing `sdk/tests/claude-readiness/` suite passes without edits.

Two behaviours are deliberately stricter than before:

- `rollUpLaneStatus` now reports `incomplete` when a required lane is absent
  from the result rather than grading the lanes that happen to be present. A
  verdict that silently drops a lane it was told to grade is the same failure as
  reporting an unevaluated lane as a pass.
- `isClaudeReadinessResult` no longer recognises a result by shape alone.
  Claude's structural discriminator (lanes + findings + badges) matches other
  readiness results too, so an explicit absent-`readinessKind` test keeps a
  different publisher's grade from being published under Anthropic's name.
