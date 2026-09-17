# Swarm reporting: implementation and verification

The reporting implementation is isolated on `codex/swarm-reporting-e2e` in both repositories. It has not been moved into the user's working checkouts or deployed.

## What to observe in the UI

Launch a new swarm with the updated backend and inspector running together.

- Execution says **Ran**, **Broke**, **Limited**, or **Withdrawn**. The separate **Goal result** says **Passed**, **Failed**, **Grading**, **Couldn't grade**, or **Not graded**.
- A session can meet the goal and then break. Its goal remains passed, while the run can be inconclusive because interrupted execution does not count as completed coverage.
- Three advisory checks run without authoring a rubric: tool errors, arguments against captured schemas, and deprecated tool calls. Observations show measured and unavailable coverage and do not override the goal judge.
- Findings and Sessions show the authoritative run report. Select a session and expand **User value chain** to inspect its stages. Missing/stale derivations remain explicitly unmeasured; partial funnels state their measured population.
- Persona, goal and target findings continue using the existing swarm mining, exemplar/contrast sessions, generation, billing and persistence pipeline. Reading reporting does not start paid analysis.

## Rollout order when these branches are adopted

1. Deploy the backend schema expansion commit first (`Expand swarm reporting schema before enabling writers`). This declares optional report, profile, readiness and source-stamp fields without writing them.
2. Deploy the remaining backend implementation, then the inspector implementation. New runners advertise `swarm-standard-checks-v1`; older workers cannot claim the new profile. Stage workers advertise evidence version 2 so an older adapter cannot publish the new source stamp.
3. The existing stage worker must run with `CHAT_STAGE_DERIVATION_ENABLED`. A disabled/unavailable worker is displayed as not measured. The existing judge recovery cron settles lost-before-claim work; disabling the judge does not erase a pinned grading obligation.

No backfill is included. Historical runs retain their checks; missing historical run decisions are not synthesized from execution counts. Deliberately ungraded sessions are not reported as never launched.

## Verification performed

- Backend tests exercise actual Convex mutations and session reads: launch, terminal interrupted execution, goal grading, advisory claims/results, exact criterion scope, stored run/report updates, on-demand regrade, stale result rejection, and lost-before-claim recovery. Provider calls in these tests are fixtures/mocks.
- Shared SDK/backend verdict fixtures cover the lifecycle/grading matrix. Report tests validate authoritative-decision copying, denominators, observation coverage, unknown execution evidence, and target identity.
- Client swarm tests cover the live matrix, session browser, Findings, navigation, and partial chain coverage. Server tests cover evidence extraction, stage adaptation, API pass-through and OpenAPI parity.
- A real Chromium component-browser test switches between passed/failed goals, interrupted execution, pending/unavailable/unrequested grading and recovered advisory friction. Run from `mcpjam-inspector/`: `./node_modules/.bin/playwright test --config playwright.swarm-reporting.config.ts`.
- SDK, client and server production builds; backend/client/CLI typechecks; backend scoped lint, mirror hash checks and use-node guard; design drift/lint checks.

This is automated integration and browser-component verification, **not a live paid swarm against a deployed backend**. No production deployment or paid analysis was started. Cross-repository mirror diff checking still reports four unrelated pre-existing mismatches (public API error mapping, benchmark claim payload, benchmark cleanup status, eval decision labels); all new swarm pairs agree and the hash ratchet passes.

## Implementation adjustments from the plan

- Target IDs contain colons, which eval case IDs reject. `swarmTargetCaseId` uses lossless base64url encoding for the eval aggregate and the same mapping for target navigation.
- OpenAPI reporting components are generated from canonical Zod schemas, with a drift test, instead of hand-maintaining another nested contract. Platform types import those canonical types.
- The built-in agent intentionally excludes the session-list operation for privacy. Its existing exclusion is preserved; REST, SDK, CLI and MCP retain the operation and return the same verdict/report payloads.
- Standard profiles are limited to swarm runs; user-testing and direct-chat adapter compatibility is preserved.
