# Inspector journey billing and plan limits

Branch: `codex/journey-plan-limits`, based on fresh `origin/main` at `1c982991b`.

## User stories and acceptance checklist

- [x] As a tester, I want each journey billed by its run kind so fees apply correctly.
  - [x] Swarm-agent create requests default to `swarm` and serialize an explicit kind.
  - [x] Standalone launches send `user_testing`; launches with a wave id send `swarm`.
- [x] As a Free or Pro collaborator, I want to see why I cannot save a teammate's settings.
  - [x] The existing suite, journey, and scenario gates retain settings visibly disabled.
  - [x] Explain that editing requires Team or Enterprise and link to the resource organization's plans.
  - [x] Preserve creator, legacy Free, Team/Enterprise, and existing role behavior.
  - [x] Display `COLLABORATIVE_EDITING_REQUIRED` as a readable toast on save rejection.
- [x] As an organization member, I want to see outstanding debt and carried credits.
  - [x] Preserve both backend fields through normalization, including real zero values.
  - [x] Display positive debt separately; label carried credits as included in the monthly balance.
- [x] As a new Free user, I want to understand how to buy credits.
  - [x] Hide Buy credits and Auto-reload when the backend reports top-ups ineligible.
  - [x] Show “Upgrade to Pro to buy credits” and prevent a top-up deep link from opening checkout.
  - [x] Preserve eligible/legacy controls; do not prescribe an upgrade for a locked wallet.

## TDD iterations

1. Added request-body, launcher, normalization, shared-gate, and credit-card expectations before implementation: **10 failed / 73 passed**. Implemented the behavior: **83 passed**.
2. Added suite/scenario/journey rejection tests, an error-code contract test, and locked-wallet coverage: **5 failed / 130 passed**. Added the shared error mapping and wired the save paths.

The backend error code was verified against current backend main's `convex/lib/collaborativeEditing.ts`. Run-kind and credit fields were checked against the backend route and balance query. Existing backend permissions remain authoritative.
3. Checked upgrade/downgrade behavior across suite, journey, and scenario gates, and loading-to-Free behavior for a top-up deep link. Final related regression run: **235 tests passed across 13 files**.

## Validation

- Focused client/server Vitest regression set: 235 passed.
- `npm run typecheck:client -w @mcpjam/inspector`: passed, including renderer and browser-viewer guards.
- `npm run design:check`: passed.
- Pinned `@google/design.md@0.4.0` linter: 0 errors; 109 existing warnings in the unchanged design specification. Run through a temporary npm cache because the shared installed dependencies lack `designmd`.
- `git diff --check`: passed.

Tests use mocked backend responses; authenticated end-to-end billing and deployed fee enforcement were not exercised.

## CI follow-up

The first full CI run exposed two outdated test contracts outside the initial focused set: the route snapshot assertion omitted the newly required `kind`, and the hosted OAuth suite's guest-session mock omitted `getGuestSessionRefusal`, which the banner added on main now reads. The hosted OAuth failure reproduced locally (62 failing tests); the route payload mismatch was confirmed in the CI log. Updated the exact route payload assertion and supplied the mock's no-refusal state; no production behavior changed.

Validation after the fix: hosted OAuth 78/78, swarm route 9/9, launch service 40/40, and swarm-agent contract 6/6 passed (133 tests total). Generated local runtime bundles with `npm run bundle:all` to run the route suite; no generated tracked files changed.
