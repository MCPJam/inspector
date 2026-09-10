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
- Stop the blurred background from shifting while the welcome screen is open. Render a stable, intentional first-run background and keep route/project hydration changes visually hidden until the welcome step finishes.

## Verification notes

- Fresh `127.0.0.1:5173` onboarding completes and stays dismissed after refresh.
- Existing `localhost:5173` state can repeat onboarding because it contains an unfinished record from the earlier flow.
- Chrome demonstrated the expected completed-refresh behavior.
- Focused onboarding state and App tests currently pass.

## Next feature: connection progress and success

- This was part of the original v3 direction, but was not included in the save-and-connect slice.
- Show three honest progress steps: reach the server, negotiate MCP compatibility, and load tools.
- Keep the progress and success UI server-agnostic: use the selected server's name and real tool count for both personal servers and the Excalidraw demo.
- Let the user cancel while work is in progress and return to server choice without completing onboarding.
- Hold on a final checkmark with the connected server name and real tool count.
- Open Playground only after the user clicks the final button; mark onboarding complete at that handoff.
- Keep this frontend-owned by mapping the existing connection and discovery state into the overlay. Add backend work only if the current APIs cannot expose a truthful stage or cancellation result.
- Test progress transitions, cancellation, success details, and refresh after completion.
- Keep failure recovery path-specific: personal-server failures open the editable form; demo failures use the dedicated demo-unavailable screen.
