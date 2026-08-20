---
"@mcpjam/sdk": minor
---

Add the OpenAI readiness runner, the submission profile, and the package and
submission check lanes.

The runner is split into two halves that do not resemble each other.
`gatherOpenAIReadinessEvidence` performs every side effect and returns a
serializable evidence object; `gradeOpenAIReadiness` is pure. That is stricter
than the Claude runner and buys three things: a hosted surface can gather on one
node and grade on another, a test can drive the whole grader from a fixture, and
a grading run cannot reach a link-local address because the half that could is a
different function.

`OpenAIReadinessResult` carries both staged verdicts. A run with a good package
and no submission profile is `ready` at `technical-preflight` and `incomplete` at
`submission-ready`, and the summary says so in one line — reporting only the
headline would tell a submitter "not ready" and send them to look at their
server.

Applicability comes from the declared submission mode throughout. A lane the
shape excludes is `not-applicable` and drops out of the stage rollup; a lane the
shape includes but the run had no input for is `not-evaluated` with the input
named. Those two must never look alike, and inference cannot tell them apart.

Two fixes fell out of building this:

- `attestations` is now a PARTIAL record. `z.record` over an enum key is
  exhaustive in zod 4, so a half-ticked form failed to parse — and a half-ticked
  form is exactly the state a preflight exists to grade. The check can now
  separate an absent key (unfinished) from a key set to `false` (refused).
- SVG parsing takes an injected `parseXml`. `@xmldom/xmldom` is banned from the
  browser entry's import graph, and a browser has `DOMParser` natively; Node
  passes `xmldomParseXml` from the Node entry. A runtime with no parser records
  a GAP rather than reporting the SVG as malformed — that limitation is ours,
  not the submitter's.

`toConformanceReport` now routes by an explicit provider registry.
`isClaudeReadinessResult` could not stay a shape test once a second readiness
result existed with the identical shape.
