# Enterprise eval SDK implementation and qualification

Candidate branches: `feat/enterprise-evals-sdk` in MCPJam/inspector and MCPJam/mcpjam-backend. Implementation date: 2026-09-13. This is an implementation review candidate, not a production launch acceptance certificate.

## Delivered

- Shared bounded reporting transport, response validation, acknowledgement accounting, recoverable streaming queues, and reporting receipts separate from local verdicts.
- Backend content-bound retry idempotency, frozen run policy/counts, explicit completeness, abandoned-run terminalization, and default-off metadata and advisory persistence capabilities.
- Canonical evaluator authoring with legacy compatibility; bounded execution, cancellation, immutable configuration snapshots, capture limits, and advisory reported measurements.
- Stable variants, local subset manifests and shared gate scope checks. Hosted subset persistence is explicitly refused until its persisted selection contract exists.
- Run names, tags, flat metadata, CI/Git provenance, run URLs, summaries, and metadata readers.
- Dependency-light `@mcpjam/evaluators`, bounded `responseCloseTo`, stored-evidence assertion backtests across API/SDK/CLI/MCP/UI, and advisory case-run evaluators.
- Local execution variants and descriptive pairwise preferences; Vitest registration/skip/focus/cleanup; installed-consumer and documentation compilation checks; changesets and dependency publication ordering.

Canonical definition hashes and verdict derivation remain shared. Advisory measurements do not change authoritative iteration verdicts. Statistical confidence intervals (K2), local recording (I4), and Python (P1) remain explicit follow-ons from the approved plan.

## Local evidence

- Full SDK suite: 357 files passed; 8,116 tests passed, 8 skipped.
- SDK TypeScript and distribution build passed. Full inspector client TypeScript check passed.
- Vitest integration: build/typecheck passed; 27 tests passed, 4 intentional skips.
- Packed evaluator/SDK/Vitest consumer harness passed isolated install, TypeScript consumer and actual documentation example compilation, plus seven child-process pass/fail/gate/skip/focus/cleanup scenarios.
- Standalone evaluator npm and pnpm consumers and source-only clean build passed; historical definition-hash and cross-repository assertion fixtures checked.
- Inspector browser daemon freshness and generated bundle prerequisites passed. Focused API/auth/catalog/UI/settings qualification: 274 tests passed across 16 files. Evaluator-first publication helper: 3 tests passed.
- Backend TypeScript passed. Final focused ingest/capability/backtest/advisory suites passed. Broad backend suite: 13,309 passed, 2 failed, 8 skipped; the two OAuth client-secret vault failures reproduce in this local environment and are not claimed to be baseline-main failures.

The PR descriptions identify the final commits and additional regression runs. Local logs are not a substitute for CI checks on those commits.

## Release prerequisites

1. Resolve the two backend vault test failures in the CI environment and pass required checks on both PR heads.
2. Merge and deploy backend expansion before releasing dependent inspector/SDK writers. See backend `docs/enterprise-sdk-launch.md` for flags, compatibility, rollback, and exact endpoint behavior.
3. Verify old/new client and backend combinations against deployed candidates, including ambiguous network acknowledgements and terminal-run retries. Unit boundary coverage exists; a deployed matrix has not been executed here.
4. Verify target-runner support before advertising `responseCloseTo`; keep new feature flags off until end-to-end persistence and readback succeed. Capability advertisement alone does not prove runner execution.
5. Verify npm organization publication authority for the new evaluator package, publish its version before SDK, then smoke actual registry artifacts and supported runtime/dependency floors.
6. Complete sustained workload/heap/cancellation measurement, seeded-secret sink checks, and API/CLI/Vitest/JSON/JUnit/HTML parity on exact release candidates. Deterministic queue/capture-bound tests do not certify sustained memory behavior.
7. Record deployed artifact versions and all LA01–LA20 observations in the approved plan. No launch acceptance row is automatically passed by merging this implementation.

Rollback stops new capability advertisement/writes first and preserves already-stored expanded data. No deployment, flag activation, package publication, or merge was performed as part of this implementation.


## Review corrections

The initial local qualification did not establish merge readiness: four deterministic tests failed in GitHub Actions, both branches conflicted with newer discovery assertions, and the hosted image omitted the evaluator workspace. The follow-up ports the discovery contracts into the extracted implementation, isolates CI metadata fixtures, preserves existing criterion IDs, and checks every Docker workspace manifest before dependency installation.

Reporting now budgets each HTTP request independently, preserves cancellation evidence, and supports explicit capability-gated partial terminalization. Optional metadata/advisory persistence yields structured warnings while retaining core acknowledgements. A validation fallback strips only optional metadata and preserves the same external identity, evidence, and policy. Hosted backtest comparisons use the producing namespace; pagination and explicit preview controls are covered by regressions.

The local Docker daemon is unavailable, so hosted image execution must be verified by the PR preview build. Backend CI on the initial candidate passed; the earlier local OAuth vault failures were not reproduced by CI. Neither PR is called merge-ready until checks run on the revised heads.
