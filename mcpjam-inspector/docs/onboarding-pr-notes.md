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
- Persist completion only after the welcome is acknowledged and the server connection succeeds.

## Bugs to fix

- Recover stale `started` onboarding records created by earlier builds. A successful setup must stay complete after refreshing the same origin.
- Record completion directly from the successful connection outcome instead of relying only on a later runtime-state observation.
- Add an integration test covering successful onboarding followed by a full refresh.
- Check the local-development welcome timer restart during project hydration; it should not freeze or visibly restart.
- Show the welcome splash only once per browser origin. If a user refreshes before choosing or connecting a server—even without clicking Continue—the next load should resume at `Point MCPJam at a server`, not replay Welcome.
- Stop the blurred background from shifting while the welcome screen is open. Render a stable, intentional first-run background and keep route/project hydration changes visually hidden until the welcome step finishes.

## Verification notes

- Fresh `127.0.0.1:5173` onboarding completes and stays dismissed after refresh.
- Existing `localhost:5173` state can repeat onboarding because it contains an unfinished record from the earlier flow.
- Chrome demonstrated the expected completed-refresh behavior.
- Focused onboarding state and App tests currently pass.

## Connection progress and success

- This was part of the original v3 direction, but was not included in the save-and-connect slice.
- Show three honest progress steps: reach the server, negotiate MCP compatibility, and load tools.
- Keep the progress and success UI server-agnostic: use the selected server's name and real tool count for both personal servers and the Excalidraw demo.
- Let the user cancel while work is in progress and return to server choice without completing onboarding.
- Hold on a final checkmark with the connected server name and real tool count.
- Open Playground only after the user clicks the final button; mark onboarding complete at that handoff.
- Keep this frontend-owned by mapping the existing connection and discovery state into the overlay. Add backend work only if the current APIs cannot expose a truthful stage or cancellation result.
- Test progress transitions, cancellation, success details, and refresh after completion.
- Keep failure recovery path-specific: personal-server failures open the editable form; demo failures use the dedicated demo-unavailable screen.

### Implementation notes

- Implemented on `feature/onboarding-connect-progress`; no backend change was needed.
- Reused the existing save-and-connect handshake, then called the existing tools-list API with a live refresh to obtain the real tool count.
- The first two checks complete only when the server reports connected; tool loading remains active until the list request resolves. No timed or simulated protocol progress is shown.
- Cancel returns to server choice, invalidates the current onboarding attempt, and disconnects its visible runtime state without completing onboarding.
- Successful setup remains on the confirmation screen until `Open Playground`; that action records completion and navigates.
- Interactive preview against the live Excalidraw demo returned 5 tools and opened the populated Playground correctly.
- Refresh after that success reproduced the already-listed stale first-run persistence bug on `localhost`; keep that repair in its own follow-up branch.
- Verification: 96 focused component/App tests passed, including both connection paths and cancellation; client type-check and design-token drift checks passed.
- Review polish: completed progress checks now use the success color; the final success indicator is green with a reduced-motion-safe entry animation; the centered server name is highlighted for easier scanning.

## Preloaded Playground prompt

- Use one server-agnostic prompt for both connection paths: `What can this server do?`
- Reuse Playground's existing initial-input, typewriter, and send-button pulse behavior; do not generate a prompt on the backend and do not auto-send it.
- Seed the prompt only when Playground opens from the successful first-run handoff, then retire the one-shot handoff after the user sends their first message.
- Verification: 192 focused App, Playground handoff, composer, and routing tests passed; client type-check and design-token drift checks passed.

## Deferred follow-ups

- Guest sign-up bar: a dismissible Playground strip inviting anonymous users to create an account so they can keep their server, history, and evals.
- Demo-only Home banner: a persistent, dismissible confirmation and client-exploration prompt while Excalidraw is the user's only connected server.
- Guided product tour: a later, dismissible spotlight sequence covering (1) the full left navigation rail, (2) the Playground configuration controls such as fill, locale, strictness, Client Context, and Host Capabilities, and (3) the sign-in/create-account area.
