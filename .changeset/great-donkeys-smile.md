---
"@mcpjam/sdk": minor
---

Add the versioned evaluation contract and make scoring the single verdict path.

`@mcpjam/sdk/contract` is a new browser-safe subpath carrying one shape for
every eval surface: `ScoreDefinition` / `ResolvedScoreDefinition`,
`ScoreResult`, and the hashed `EvaluationConfigSnapshot` that joins them.
Hashing is pinned cross-runtime (RFC 8785-style canonical JSON + SHA-256 over
resolved definitions) so the SDK, the CLI, the inspector client and the Convex
backend all derive the same digest.

`EvalTest` now derives `passed` exclusively from gating scores. `test()`,
`expectedToolCalls` and each predicate are projected into scores rather than
being consulted separately, so scoring replaces the old verdict expression
instead of joining it as another opinion. Verdicts are unchanged for existing
tests: each source contributes one gating score of exactly the value it used to
contribute, and `predicateResults` / `toolMatch` stay populated from the same
single evaluation that feeds the scores.

New: `predicateScorer`, `judgeScorer` and a `scorers` config field, with
runner-enforced per-scorer timeouts and a concurrency cap. Judges are advisory
by default; a gating scorer that errors or is skipped fails the iteration
unless the author opts out. Scores ride on `metadata.scores` /
`metadata.evaluationConfig`, and the run's `evaluationConfigHash` is sent on
run start.
