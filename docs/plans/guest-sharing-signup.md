Fixes #5153.

Guests should be able to try MCPJam privately, then sign up to share without losing their scenario or history.

## User stories
- [ ] As a guest, I see “Sign up to share” when public sharing or link rotation requires an account.
- [ ] As a guest, I can sign up, keep my scenario/history, and return to retry sharing.
- [ ] As a new guest, my demo starts privately and onboarding works.
- [ ] As a signed-in user, I can share normally; unrelated errors still explain what failed.

## Validation
Tests first for each story: reproduce the failure, make it pass, then run the surrounding regression suites. This PR stays draft while the checklist is in progress.
