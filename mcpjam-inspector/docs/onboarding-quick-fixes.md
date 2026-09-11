# BB-217 onboarding — suggested quick fixes

These came out of a review of `feature/onboarding-main` and are the items that looked small and
mechanical enough to be worth doing before the branch merges. They are suggestions, not
requirements. Each one is independent, so take them in any order, skip any that turn out to be
larger than described, and use your own judgement if the surrounding code has moved since this was
written. If a fix starts pulling in a refactor, leave it and note why — the deeper items are
already tracked in `onboarding-review-followups.md`.

Where a line number is given, treat it as a starting point rather than an exact address.

---

## 1. Formatting

From `mcpjam-inspector/`:

```bash
npx prettier --write client/src/App.tsx client/src/__tests__/App.hosted-oauth.test.tsx
```

The branch was formatted with Prettier 2.x while the workspace pins 3.9.6, so about a dozen hunks in
`App.tsx` change only nested-ternary indentation and `??` parens in code the feature never touches.
`App.hosted-oauth.test.tsx` is Prettier-clean on `main` and has roughly 29 drift lines on the branch.

Worth limiting to these two files. The other changed files are already non-Prettier on `main`, so
formatting them would produce a large diff unrelated to this work.

## 2. stdio command line is not split into arguments

`client/src/App.tsx`, in `openFirstRunServerConnection` (~L3406-3414), builds `{ command: draft.urlOrCommand }`
with no `args`, so something like `npx -y some-server` is spawned as a single executable name and
always fails. Splitting on whitespace, with the first token as `command` and the rest as `args`,
matches what `client/src/components/connection/hooks/use-server-form.ts` (~L839-845) already does.

## 3. Playground restore effect overrides the user's selection

`client/src/App.tsx` (~L3692-3731). This effect re-asserts the onboarding server whenever
`appState.selectedServer` or `selectedMultipleServers` change, and its gate — a stored status of
`completed` — stays true indefinitely, so a user can never pick a different server on Playground.

A one-shot ref around the selection writes keeps the intended restore-after-refresh behaviour while
letting later changes stick. The reconnect behaviour below it can stay as is.

## 4. Dead `.catch`

`client/src/App.tsx` (~L3717-3720). `ensureServersReady` resolves on every path rather than
rejecting, so this handler and its comment about a later render retrying cannot run. Removing both
is the simplest option; reading the returned buckets instead would also work if a retry is actually
wanted.

## 5. Demo tool count

`client/src/components/onboarding/FirstRunOnboardingOverlay.tsx` (~L358) hardcodes
`6 tools · no setup · nothing to install`, but the demo returns 5 and the success screen shows the
real count moments later. Dropping the number from the copy avoids the drift entirely. The assertion
in `client/src/components/onboarding/__tests__/FirstRunOnboardingOverlay.test.tsx` (~L354) expects
the current literal and would need updating alongside it.

## 6. Non-functional credential controls

In the same overlay's details form, the "Bearer token" option (~L566) and the "Header" input
(~L577-583) do not currently do anything. `App.tsx` never reads `draft.header`, no `headers` or
`secretPatch` is built, and there is no field for a token value anywhere, so choosing Bearer sends
an auth method with no credential and the server rejects it again.

Removing both controls, and the now-unused `serverHeader` state and `header` plumbing, leaves the
form offering only what works. Wiring real credential capture is the better long-term fix but is a
bigger change — see the follow-ups doc.

---

## Checks

From `mcpjam-inspector/`:

```bash
npx vitest run client/src/__tests__/App.hosted-oauth.test.tsx client/src/components/onboarding client/src/components/playground/__tests__ client/src/hooks/__tests__ client/src/lib/__tests__/onboarding-state.test.ts
```

```bash
npx tsc --noEmit -p client/tsconfig.typecheck.json
```

Both passed before these changes (277 tests), so any failure is attributable.
