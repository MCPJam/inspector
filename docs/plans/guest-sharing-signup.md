Fixes #5153.

Guests should be able to try MCPJam privately, then sign up to share without losing their scenario or history.

## User stories
- [x] As a guest, I see “Sign up to share” when public sharing or link rotation requires an account.
- [x] As a guest, I can sign up, keep my scenario/history, and return to retry sharing.
- [x] As a new guest, my demo starts privately and onboarding works.
- [x] As a signed-in user, I can share normally; unrelated errors still explain what failed.

## Validation
The first run reproduced four failures before implementation (85 existing tests passed). The fix passes the sharing, scenario, bootstrap, guest-session, promotion-proof, and sign-in-return regression suites.

On fresh main, client bootstrap has replaced the old demo-seeding path. `ClientSelectionSync` now explicitly requests `project_members` for its first-run host/scenario.

The prompt delegates to the existing WorkOS signup/sign-in and `useEnsureDbUser` promotion-proof flow. It retains the activation marker and saved scenario/link; users return to the same page and retry sharing. No automatic public publish occurs after auth.

The live backend promotion transaction is owned by the companion backend change; frontend tests cover the proof handoff, not a live account migration.
