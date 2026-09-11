# Onboarding PR Notes

## Goal

- Build and review onboarding incrementally from `feature/onboarding-main`.
- Keep frontend and backend responsibilities explicit.
- Merge each approved onboarding sub-branch into the integration branch without changing `main`.

## Decisions so far

- Use the existing save-and-connect path for both the demo server and a user's own server.
- Show editable server details only after an automatic connection attempt fails.
- Keep the explicit server-choice flow separate from the legacy automatic Excalidraw onboarding state.
- Treat `localhost` and `127.0.0.1` as separate browser origins during local testing.
- Record the one-time welcome as soon as it is rendered, then resume unfinished sessions at server choice.
- Persist completion from the successful connection and tool-discovery outcome; the final button remains an explicit navigation handoff.
- Keep the original Home-first onboarding backdrop until a later shell-loading pass can move it safely.

## Completed bug fixes

- Added a mild backdrop blur to server choice and later steps while retaining the stronger Welcome depth effect.
- Welcome now records `shownAt` on render. A refresh before interaction resumes at `Point MCPJam at a server` instead of replaying the splash and timer.
- Successful tool discovery now persists completion immediately, so refreshing before or after `Open Playground` cannot restart onboarding.
- Interrupted connection records now remember the attempted server and auto-repair only when that same server is connected. Legacy records auto-repair only after a conservative stale interval with exactly one connected server, preventing an unrelated hydrated server from closing a fresh choice screen.
- Refreshing after successful onboarding restores the chosen server selection, reconnects that saved server, and retains the prefilled Playground prompt until the user sends it.
- Personal failure still opens the editable form and demo failure still opens the demo-unavailable screen.
- Personal and demo failures now show a compact, plain-language connection notice with the original diagnostic available through an explicit technical-details disclosure.
- The demo recovery link is centered, and Welcome now fades over a nearly opaque theme-aware backdrop so route changes are no longer visible through the splash.
- Light-mode Welcome uses a subtle primary-token dot grid with a borderless clear halo behind the copy; onboarding failures suppress the duplicate toast because the inline disclosure owns the diagnostic.
- Rolled back the experimental Playground-first backdrop and startup-choice hydration screen after they exposed an invalid temporary project ID during guest provisioning; Home remains the stable first-run backdrop.
- Added App, state, overlay, refresh, stale-record, and blur regression coverage.

## Verification completed

- 254 focused App, onboarding-state, overlay, connection-state, and Playground tests pass, covering both server paths, reconnection, failure recovery, and durable prompt restoration.
- Client type-check passes.
- Design drift and design lint pass with no errors; only the repository's existing unused-token warnings remain.
- Interactive preview confirms the approved Welcome styling over Home, refresh resumes at `Point MCPJam at a server`, and no invalid-project error occurs.
- The broader repository suite was also sampled; unrelated socket, subprocess, DNS, and headless-browser tests cannot run in the restricted sandbox and time out there.

## Pre-PR review quick fixes

- Reformatted only `App.tsx` and `App.hosted-oauth.test.tsx` with the package's pinned Prettier 3.9.6.
- Split first-run stdio input into an executable and argument list before using the existing connection path.
- Made the post-refresh onboarding server selection restore one-shot, so later Playground server choices remain user-controlled.
- Removed the unreachable rejection handler from `ensureServersReady`, which reports failures in its resolved result buckets.
- Replaced the stale hardcoded Excalidraw tool count with `No setup · nothing to install`; the success screen still reports the live count.
- Removed Bearer-token and custom-header controls from onboarding because the form did not collect or submit their credential values. OAuth, automatic authentication, and no-auth remain available.
- Added regressions for stdio parsing, user-controlled selection after restore, and the supported credential choices.
- Verification on `feature/onboarding-quick-fixes`: 1,676 focused tests pass with 6 existing skips; client type-check and targeted Prettier check pass.
- Reused the initial onboarding-state snapshot during eligibility checks instead of parsing localStorage on every App render.
- Made legacy `completed` records without `shownAt` recoverable and ensured newly completed records always carry that marker.
- Failure recovery actions now reset the parent connection state before returning to server choice, so stale errors cannot reopen later.
- Removed the redundant Welcome-acknowledgement alias and its duplicate persistence write.
- Added state and overlay regressions for these recovery paths; 145 directly affected tests and client type-check pass.
- Removed completed findings from `onboarding-review-followups.md`. The unrelated developer onboarding and repository-flow guides remain isolated on `small-doc-fixes`.
- Checkpointed a shared connection-preflight readiness signal so first-run onboarding does not launch while the connection hook still reports project or client-config setup work.
- Added a focused preflight regression; 205 App and state tests plus the 3 local-Chrome connection tests pass. Live mixed-worktree testing still reproduced a later local `Finishing setup.` failure, so the finding remains open for a clean single-checkout/single-browser retest.

## Remaining before integration

- None. The user approved the personal and demo paths, failure presentation, refresh behavior, and final Welcome styling.

## Connection progress and success

- This was part of the original v3 direction, but was not included in the save-and-connect slice.
- Show three honest progress steps: reach the server, negotiate MCP compatibility, and load tools.
- Keep the progress and success UI server-agnostic: use the selected server's name and real tool count for both personal servers and the Excalidraw demo.
- Let the user cancel while work is in progress and return to server choice without completing onboarding.
- Hold on a final checkmark with the connected server name and real tool count.
- Open Playground only after the user clicks the final button; persist successful setup before that CTA so refresh remains safe.
- Keep this frontend-owned by mapping the existing connection and discovery state into the overlay. Add backend work only if the current APIs cannot expose a truthful stage or cancellation result.
- Test progress transitions, cancellation, success details, and refresh after completion.
- Keep failure recovery path-specific: personal-server failures open the editable form; demo failures use the dedicated demo-unavailable screen.

### Implementation notes

- Implemented on `feature/onboarding-connect-progress`; no backend change was needed.
- Reused the existing save-and-connect handshake, then called the existing tools-list API with a live refresh to obtain the real tool count.
- The first two checks complete only when the server reports connected; tool loading remains active until the list request resolves. No timed or simulated protocol progress is shown.
- Cancel returns to server choice, invalidates the current onboarding attempt, and disconnects its visible runtime state without completing onboarding.
- Successful setup remains on the confirmation screen until `Open Playground`; completion is already durable and the action performs the prompt handoff.
- Interactive preview against the live Excalidraw demo returned 5 tools and opened the populated Playground correctly.
- Refresh persistence and stale-record recovery are now handled in the combined bug-fix branch.
- Verification: 96 focused component/App tests passed, including both connection paths and cancellation; client type-check and design-token drift checks passed.
- Review polish: completed progress checks now use the success color; the final success indicator is green with a reduced-motion-safe entry animation; the centered server name is highlighted for easier scanning.

## Preloaded Playground prompt

- Use one server-agnostic prompt for both connection paths: `What can this server do?`
- Reuse Playground's existing initial-input, typewriter, and send-button pulse behavior; do not generate a prompt on the backend and do not auto-send it.
- Seed the prompt only when Playground opens from the successful first-run handoff, then retire the one-shot handoff after the user sends their first message.
- Verification: 192 focused App, Playground handoff, composer, and routing tests passed; client type-check and design-token drift checks passed.

## Deferred follow-ups

- Guest sign-up bar: a dismissible Playground strip inviting anonymous users to create an account so they can keep their server, history, and evals.
- Excalidraw-only connection banner on Home and Playground moved into the separate `BB-217 Onboarding Next Phase` task and sub-feature branch.
- Guided product tour: a later, dismissible spotlight sequence covering (1) the full left navigation rail, (2) the Playground configuration controls such as fill, locale, strictness, Client Context, and Host Capabilities, and (3) the sign-in/create-account area.
