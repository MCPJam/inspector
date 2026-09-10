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
- Keep Playground mounted beneath normal onboarding. Use Home as the recovery backdrop only after both the personal and demo paths have failed.

## Completed bug fixes

- Replaced the first-run Home redirect with a stable, project-scoped Playground backdrop, removing the visible Home-to-Playground swap during Welcome, connection, and success.
- Added a mild backdrop blur to server choice and later steps while retaining the stronger Welcome depth effect.
- Welcome now records `shownAt` on render. A refresh before interaction resumes at `Point MCPJam at a server` instead of replaying the splash and timer.
- Successful tool discovery now persists completion immediately, so refreshing before or after `Open Playground` cannot restart onboarding.
- Interrupted connection records now remember the attempted server and auto-repair only when that same server is connected. Legacy records auto-repair only after a conservative stale interval with exactly one connected server, preventing an unrelated hydrated server from closing a fresh choice screen.
- Personal failure still opens the editable form and demo failure still opens the demo-unavailable screen. Home becomes the background only after both paths have failed.
- Added App, state, overlay, refresh, stale-record, route-stability, dual-failure, and blur regression coverage.

## Verification completed

- 145 focused App, onboarding-state, overlay, and Playground tests pass.
- Client type-check passes.
- Design drift and design lint pass with no errors; only the repository's existing unused-token warnings remain.
- Clean Codex-browser preview confirms Welcome advances once, refresh resumes at `Point MCPJam at a server`, and the choice screen stays open over Playground.

## Remaining before integration

- User-check the personal-server success and failure paths, demo success and failure paths, and refresh after success in the normal local browser session.
- After user approval, merge the combined bug-fix branch into `feature/onboarding-main` and finalize these notes for the eventual PR. Do not open a PR or change `main` yet.

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
