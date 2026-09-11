# BB-217 onboarding — review follow-ups

Findings from a deep review of `feature/onboarding-main` vs `main` (16 files, +2799/-155).
Split into what was fixed before the PR and what is deferred.

Status legend: **CONFIRMED** = trigger and wrong result traced end to end.
**LIKELY** = mechanism traced by review, final verification not completed.

---

## Tier 1 — quick, mechanical (do before/with the PR)

### 1. Prettier drift (CONFIRMED)
The branch was formatted with Prettier 2.x; the workspace pins 3.9.6 (`mcpjam-inspector/package.json:262`).
Twelve hunks in `client/src/App.tsx` change only nested-ternary indentation and `??` parens in
code the feature never touches, and `client/src/__tests__/App.hosted-oauth.test.tsx` is
Prettier-clean on `main` but has 29 drift lines on the branch. New code also omits trailing
commas despite `trailingComma: "all"`.

```bash
cd mcpjam-inspector && npx prettier --write client/src/App.tsx client/src/__tests__/App.hosted-oauth.test.tsx
```

CONTRIBUTING.md asks for `npm run prettier-fix -w @mcpjam/inspector` before committing. Note that
9 of the 10 touched files are already non-Prettier on `main`, so do not format the whole set —
only these two, which are almost entirely branch-introduced drift.

### 2. stdio command line is never split into argv (LIKELY, three independent traces)
`client/src/App.tsx` ~L3409 builds `{ command: draft.urlOrCommand }` with no `args`.
`toMCPConfig` (`client/src/state/server-helpers.ts:13`) and `StdioClientTransport`
(`sdk/src/mcp-client-manager/MCPClientManager.ts:2670`) forward it verbatim, so
`npx -y @modelcontextprotocol/server-everything` is spawned as one executable name and
fails ENOENT. The overlay's copy promises "HTTP, SSE, and stdio all work"; today only
zero-argument commands can connect. The existing form already splits
(`client/src/components/connection/hooks/use-server-form.ts:839-845`).

Fix: split on whitespace, first token to `command`, rest to `args`.

### 3. Playground restore effect overrides the user's server selection forever (CONFIRMED)
`client/src/App.tsx:3699-3707`. The effect gates on `initialFirstRunServerChoiceState?.status === "completed"`,
read once at mount from a localStorage key that is never cleared, and depends on
`appState.selectedServer` / `appState.selectedMultipleServers` while also writing them.
`restoredFirstRunServerRef` guards only the reconnect, not the selection.

Result: in every session after onboarding, selecting a different server on Playground snaps back,
and untoggling the onboarding server in multi-select re-adds it. The user can never deselect it
while it exists in the project.

Fix: add a one-shot ref around the selection writes, or gate on the consumable
`playgroundPromptPending` signal instead of the permanent `completed` status.

### 4. Dead `.catch` (CONFIRMED)
`client/src/App.tsx:3717-3720`. `ensureServersReady` never rejects — it resolves
`{ready, missing, failed, reauth}` on every path — so the reset that the comment says lets
"a later render retry after a transient startup failure" can never run. Remove it or check
the returned buckets.

### 5. Hardcoded "6 tools" for the demo (LIKELY)
`client/src/components/onboarding/FirstRunOnboardingOverlay.tsx:358` promises
"6 tools · no setup · nothing to install", while the success screen renders the real count.
`docs/onboarding-pr-notes.md` records the live demo returning 5. Drop the number from the copy
(the test at `__tests__/FirstRunOnboardingOverlay.test.tsx:354` asserts the literal).

### 6. Non-functional credential controls in the recovery form (CONFIRMED)
The details form offers a "Bearer token" option and a "Header" input (placeholder `X-Api-Key`),
but `draft.header` is never read in `App.tsx` and no `headers`/`secretPatch` is ever built, and
there is no field for a token value anywhere. Choosing Bearer sends `authMethod: "bearer"` with
no credential, so the server 401s again with no indication the input was ignored.

Cheapest honest fix: delete the Header input and the Bearer option until credentials are wired.
Proper fix is Tier 2 item 3.

---

## Tier 2 — deferred (needs design or refactor, not PR-blocking)

### 1. Cancel does not cancel (CONFIRMED)
`App.tsx:3583-3590`. `handleRuntimeDisconnect` only dispatches `DISCONNECT`; it does not bump the
per-server op token (`nextOpToken` runs only in connect/reconnect paths) and `guardedTestConnection`
has no abort. The in-flight `handleConnect` therefore passes `isStaleOp`, dispatches `CONNECT_SUCCESS`,
and fires `toast.success("Connected successfully!")`. In hosted mode `syncServerToConvex` already
persisted the row before the handshake, and cancel removes nothing.

User-visible: click Connect, click Cancel, and seconds later a success toast appears over the
choice screen with the server live and saved. The demo's success toast is suppressed only when the
*legacy* key holds `status: "seen"` (`use-server-state.ts:126-131`), which the new flow never writes.

Worse variant, also CONFIRMED: if the page was reloaded mid-attempt (so the stored record is
`started` with `attemptedServerName`), the background success lets the repair effect
(`App.tsx:3573`) call `markFirstRunServerChoiceCompleted()` and dismiss the overlay — onboarding
completes even though the user cancelled.

### 2. `handleConnect` preflight guards strand the overlay (LIKELY, three independent traces)
`use-server-state.ts:3308-3313`. `notifyIfClientConfigSyncPending()` and
`notifyIfProjectNotProvisioned()` call `toast.error` directly (L1312, L1337) rather than the new
`showConnectionError`, so `suppressErrorToast: true` does not silence them, and both return
*before* `dispatch({type:"CONNECT_REQUEST"})`. No server record is ever created, so the App effect's
`if (!server) return` never advances and the overlay spins on "Connecting to …" with only Cancel.

Trigger gap: App's `isFirstRunProjectReady` (L3454) short-circuits on `!HOSTED_MODE`, but the hook's
guard keys off `isAuthenticated && !sharedProjectId`, and nothing in the new flow waits on
`isClientConfigSyncPending` — which the legacy path explicitly did (`use-onboarding.ts:247-249`).

Right-depth fix: have `handleConnect` return a discriminated result (the shape
`reconnectServerInternal` already returns) instead of `Promise<void>`, and move toasting to a thin
default wrapper. That also deletes the `lastError` polling effect, which is a second mechanism for
learning an outcome `handleConnect` already knew.

### 3. "Auto" authentication cannot reach the OAuth offer (CONFIRMED)
`App.tsx:3412` sets `useOAuth: draft.authentication === "oauth"`, but the overlay's initial Connect
hardcodes `"auto"`. In `handleConnect` the stored-credential probe and the `authMethod === "auto"`
escalation prompt both sit inside `if (formData.type === "http" && formData.useOAuth && formData.url)`
(L3483), so an OAuth-protected server entered through onboarding gets a raw 401 and is never offered
OAuth. The real form sets `useOAuth = !autoSelectsXaa` for "auto"
(`use-server-form.ts:933-934`), and the saved row carries the contradictory pair
`useOAuth: false, authMethod: "auto"` while the server modal displays it as "Automatic".

A manual Reconnect on the failed card *can* still reach the offer, since that path keys off
`authMethod` alone — so this is recoverable but not discoverable.

### 4. OAuth redirect loses the flow (LIKELY, not fully verified)
`handleConnect` upserts `connectionStatus: "oauth-flow"` and navigates away. App's connecting effect
handles only `"connected"` and `"failed"`, and all in-memory `firstRunConnectionState` is lost across
the redirect. On return the stored record is `started + shownAt`, so the overlay reopens at the
*choice* step while the callback reconnects in the background; on success the repair effect marks
completion silently, so the user never sees the connected screen, the tool count, or the seeded
Playground prompt. On failure they get the choice screen with no error at all.

### 5. Eligibility bypasses the blocking-servers check (LIKELY)
`lib/onboarding-state.ts:234`. `if (persisted?.status === "started" && persisted.shownAt) return true;`
runs before `return !hasAnyBlockingServers`, and the storage key is global rather than per-project or
per-account. A user who reaches the choice screen and leaves can later open a populated
`/p/<teamProject>/servers` and get "Point MCPJam at a server" over a project full of servers; the
repair effect cannot fire because `attemptedServerName` is unset. Only "Set up later" exits.

Root cause, per the altitude pass: eligibility is derived from live server presence, which the flow
itself flips by saving a server. The four patches around it (`firstRunOverlaySessionStarted` latch,
the `isFirstRunConnectionActive` carve-out inside the argument, this early `return true`, and the
in-memory `firstRunOverlayDismissed`) all collapse if eligibility reads persisted status only and
server presence is used exactly once to seed the initial record.

### 6. Malformed project URL hides the inaccessible-project error (LIKELY)
The removed guard on `main` carried a long comment about exactly this: `/p/<malformed>/servers`
matches the route, and the boundary answers with the inaccessible state. `hasProjectScopedFirstRunDestination`
(`App.tsx:3361`) now matches any `/p/` path, valid or not, and the overlay is a sibling of
`HostedShellGate`, so it renders on top of that error. No test covers malformed id plus first run.

### 7. Remote onboarding flag is no longer written (LIKELY, intentional per notes)
The gate dropped `!hasSeenFirstRunOnboarding`, and nothing in the new flow writes any remote flag —
the only `users:markOnboardingShown` caller needs `firstRunComposerSeed`, which is unreachable under
`autoConnectFirstRun={false}`. A new signed-in account that finishes onboarding sees Welcome again on
every other browser and device. `docs/onboarding-pr-notes.md` says this "stays local for now".

### 8. Back from a failure leaves the parent stuck on `failed` (CONFIRMED)
Overlay "Back" (L598) and "Connect my own server" (L475) only call `setStep("choose")`; the parent's
`firstRunConnectionState` stays `failed` for the session. On a non-project route, navigating away and
being bounced back to Home flips `open` false then true, and the status-to-step effect re-maps the
stale failure — the user lands back on "Set up your server" with the old error.

### 9. One-frame flash of the wrong step (LIKELY)
Every overlay branch requires `step` and `connectionState.status` to agree, and `step` is corrected in
a passive effect. On async transitions (`connecting → failed`/`connected`) the committed render matches
no guarded branch and falls through to the final `else`, painting the "Set up your server" form for a
frame. Computing `step` during render removes both the flash and the silent fallback.

### 10. `completed` without `shownAt` is an unrecoverable trap (CONFIRMED logic, testers only)
`onboarding-state.ts:228` treats such a record as eligible, but `markFirstRunServerChoiceStarted`,
`...WelcomeShown` and `...Dismissed` all early-return on `completed`, so `shownAt` and `dismissed` can
never be written — Welcome replays on every load and "Set up later" is a silent no-op. The producer is
the `isLegacyStaleConnection` repair branch. Not reachable through the current build's own UI, since
the storage key has never shipped to `main`, so only testers of earlier branch builds can hold one.

### 11. Per-render localStorage read (LIKELY)
`isFirstRunServerChoiceEligible` is evaluated inline in App's render body and reads and parses
localStorage before its `!hasAnyBlockingServers` check. The old function returned on blocking servers
first and was additionally gated by `!hasSeenFirstRunOnboarding`. Every steady-state user now pays a
synchronous read on every render of the root component. The snapshot already exists as
`initialFirstRunServerChoiceState` — pass it in.

### 12. Migration heuristic for data that never shipped
The `isLegacyStaleConnection` branch (`attemptedServerName === undefined`, exactly one connected
server, 5-minute staleness) repairs records written by *earlier commits on this branch*. The storage
key, `attemptedServerName`, and the heuristic are all branch-only. If developer browsers are the
concern, bump the key instead of shipping a wall-clock heuristic that can auto-complete onboarding for
a guest who saved a second server and refreshed six minutes later.

### 13. Cleanup cluster
- The legacy auto-connect flow is dead but maintained behind `autoConnectFirstRun`, which defaults to
  `true` while the only live consumer passes `false`. `isFirstRunEligible` has no non-test callers yet
  the branch extended it; `markOnboardingDismissed` is new with no callers.
- The route allowlist is duplicated verbatim between the two eligibility functions.
- `markFirstRunServerChoiceWelcomeAcknowledged` is a pure alias of `...WelcomeShown`, and the overlay
  calls both, writing the same record twice.
- The four persistence writers each hand-copy the same four fields; a single patch-merge writer would
  have prevented the `attemptedServerName ?? current?.attemptedServerName` papering-over.
- The details form reimplements `AddServerModal` at lower fidelity; `ConnectionFailureNotice`
  reimplements `ui/error-card.tsx`; two raw `<select>` elements bypass the design-system `Select`.
- Repeated Tailwind strings in the overlay (label x6, link button x4 plus 2 drifted, title x5) have
  already started to drift.

### 14. Design-system rule violations
`DESIGN.md` states "no backdrop blur, no frosted-glass panels" and "Modal scrims use `overlay`".
The overlay uses `backdrop-blur-[32px] backdrop-brightness-50` and `backdrop-blur-sm`, and its
`DialogOverlay` className replaces the base `bg-overlay` via twMerge. Roughly 25 other client files
already use `backdrop-blur`, so the rule is not enforced today, and the notes record the blur as
deliberate — worth a decision rather than a silent exception.

### 15. Test gaps
No coverage for: the `autoConnectFirstRun` forwarding through `usePlaygroundState` (the App suite
mocks `PlaygroundTab` wholesale), the legacy-stale repair branch, the `ensureServersReady` catch path,
or any non-default Transport/Authentication/Header value in the details form.

---

## Verification run during review

- 277 tests across the 7 touched test files pass.
- `npm run typecheck:client` passes.
- `npm run design:check` passes; `npm run design:lint` reports 0 errors and 109 pre-existing warnings.
- `npx prettier --check` fails on 10 changed files (see Tier 1 item 1).
