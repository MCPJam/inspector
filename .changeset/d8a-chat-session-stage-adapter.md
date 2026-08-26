---
"@mcpjam/sdk": patch
"@mcpjam/inspector": patch
---

D8a: one stage-derivation contract for chat sessions, not a second one

`deriveStageResults` was written for authored eval cases, and every field it
reads to decide `notApplicable` is an authoring signal. A chat session — a real
User Testing transcript, a swarm journey run, a playground conversation —
authors nothing, so the analyzer had two ways to be wrong about one:
`selection` could pass off a bare tool call, and `userValue` could read as
`notApplicable` on a session where someone plainly asked for something.

`StageAuthoredCase` grows two optional fields, both absent by default so every
existing eval caller derives byte-identically (the historical-parity corpus is
re-pinned for the version bump and otherwise unchanged):

- `hasUserAsk` — a real ask exists. Makes `userValue` applicable with nothing
  authored to grade it, so an ungraded ask is `notMeasured` ("we do not know
  whether they were served") rather than `notApplicable` ("there was nothing to
  serve"). Those are different claims and the chain now keeps them apart.
- `toolExpectation: "required" | "not_required" | "open"` — what the ask says
  about whether a tool should have been called. Under `open`, `call` and
  `response` become applicable so observed spans can decide them, and
  `selection` can never reach `passed` without a turn that actually declared
  expected calls. That a tool ran is not evidence the right tool ran.

`STAGE_ANALYZER_VERSION` moves to 5.

New: `buildChatSessionStageInput` in `@mcpjam/sdk/contract` — a pure adapter
that normalizes one chat session's evidence (readiness, deterministic criteria,
a goal judge, trace spans) into the SAME analyzer input an eval iteration goes
through. It is not a second derivation and does not derive anything itself. Its
rules are pinned by golden fixtures across all three sources:

- Deterministic criteria (production checks for User Testing, the pinned rubric
  for swarm) are authoritative; the goal judge fills only their silence, and is
  never promoted into the silence a BROKEN grader left.
- A grader that failed is `notMeasured`, never a product failure.
- No connection failure is manufactured: the adapter emits no setup signals at
  all, so `connection` is established positively or stays `notMeasured`.
- Readiness is evidence, not a verdict. `not_ready` is not a failed chain.

Identical normalized evidence produces identical rows on every surface — the
source never reaches the analyzer input.
