---
name: run-inspector
description: Start the MCPJam Inspector locally, drive it with the inspector driver (screenshots, ARIA snapshots, console and network errors), and check a change in the running app. Use for any UI change, to reproduce a UI bug before fixing it, and whenever a fix needs to be seen working, not only tested.
---

# Run the inspector

## Drive it with the inspector driver

`mcpjam-inspector/scripts/inspector-driver.mjs` starts one instance, opens
screens in headless Chromium signed in the way the e2e suite signs in, and
prints a short report: final URL, title, every console error and warning,
uncaught page error, and failed or 4xx/5xx request. Screenshots, ARIA
snapshots and a JSON report go to disk, and their absolute paths are printed.
Use it before you claim a UI change works; reading the diff is not evidence.

From the repo root:

```bash
node mcpjam-inspector/scripts/inspector-driver.mjs start            # picks a free instance, waits until ready
node mcpjam-inspector/scripts/inspector-driver.mjs surfaces         # surface ids and routes (shared/app-surfaces.ts)
node mcpjam-inspector/scripts/inspector-driver.mjs open servers     # one screen: report + screenshot + ARIA snapshot
node mcpjam-inspector/scripts/inspector-driver.mjs open hosts --theme dark
node mcpjam-inspector/scripts/inspector-driver.mjs run steps.json   # an interaction, step by step
node mcpjam-inspector/scripts/inspector-driver.mjs sweep            # every surface, one line each
node mcpjam-inspector/scripts/inspector-driver.mjs stop             # stops only what `start` started
```

- `open` takes a surface id, nav segment or sidebar title (`servers`,
  `clients`, `Connect`), a path (`/p/<id>/servers`) or a URL. Project screens
  load from their logical path and the app adds `/p/<projectId>` itself.
- Exit code 0 means clean, 1 means an ISSUE line was printed, 2 means the
  driver could not run. `grep -E '^(RESULT|FAIL)|ISSUE'` pulls the verdict.
- Warnings never fail a run. Known noise on clean main goes in
  `mcpjam-inspector/scripts/inspector-driver.allowlist.json`, one rule per
  message with a `reason`; never allowlist an error your change introduced.
- To drive an instance you started yourself, pass `--base-url
  http://localhost:<client-port>` and `--token '<access link>'` (or set
  `MCPJAM_DRIVER_BASE_URL` and `MCPJAM_SESSION_TOKEN`).
- `--fresh` keeps the first-run onboarding (it is marked done by default),
  `--headed` shows the browser, `--out <dir>` picks the artifact folder.
- `start` runs `npm run dev:hosted -- <N> --no-worker` (`--worker` adds the
  platform MCP worker, `--skip-prepare` skips the SDK and bundle builds,
  `--env-file <profile>` picks the backend profile, for example
  `.env.development`) with a token it chose, and logs to the file it prints. It stops the
  instance again if it is not ready within `--ready-timeout` seconds. Use
  `--skip-prepare` only when `npm run bundle:all -w @mcpjam/inspector` has
  run in this worktree: without the bundles the server crashes, and under
  `tsx watch` a crash waits silently instead of exiting.

Steps are JSON. Each step names one action: `goto`, `click`, `hover`,
`fill` (with `value`), `press` (a key, with optional `on`), `waitFor`
(optional `state`: `visible` or `hidden`), or `screenshot` (a name).
Selectors are Playwright selectors (`role=button[name="Add server"]`,
`text=Connected`, `css=...`) plus `testid=`, `label=` and `placeholder=`.
Take names from the `.aria.yml` an `open` wrote rather than guessing them;
the file below shows the shape, not the current labels:

```json
{
  "start": "servers",
  "steps": [
    { "click": "role=button[name=\"Add server\"]" },
    { "fill": "label=URL", "value": "http://localhost:3001/mcp" },
    { "press": "Enter", "on": "label=URL" },
    { "waitFor": "text=Connected" },
    { "screenshot": "connected" }
  ]
}
```

A run stops at the first failing step, prints it as `step N FAIL` with the
reason, and still saves a screenshot of where it stopped.

When every screen reports `no-app-shell` with a console error about the
JWT's `kid` not matching the provider's JWKS, or `http-429` on
`/api/web/guest-session`, guest sign-in is failing, not your change: see
[When guest sign-in fails](#when-guest-sign-in-fails), and stop retrying,
because each load mints a guest and the authority rate-limits by network.

## Start it by hand

From the repo root:

```bash
npm run dev:worktree -w @mcpjam/inspector -- auto --no-worker
```

- Use the client and server ports printed by the launcher; `auto` selects an
  available instance. To pin an instance, replace `auto` with its number.
- Omit `--no-worker` when the change touches the Home agent's workspace tools
  or `mcp/`; the launcher then starts the platform MCP worker too.
- Run it in the background and wait for the client and server to log ready.
- The launcher resolves one runtime profile for every child process. The local
  target reads `.env.local` plus this worktree's `.env.development.local`; it
  can read the main worktree's overlay in place when this worktree has none.
  `--env-file <profile>` selects a complete profile without either overlay.
- Backend and sign-in settings exported in the shell are ignored, and each
  settings group comes from one profile layer. Use a profile to change the
  backend, not exported Convex URLs. See [Running several instances](../../../CONTRIBUTING.md#running-several-instances-worktrees).

## Sign in

The dev command prints a line like:

```
➜ Dev
http://localhost:<client-port>/...<access token>...
Keep this link private: it signs a browser in.
```

Open that exact link in the browser; the bare client URL does not
carry the session token. Never paste the link into a PR, comment or log.

Signed-in flows (WorkOS) need a real account: see the next section.

## QA a PR, signed in

Signed-in checks need a real account on a backend of your own. MCPJam staff
get one from Jamroom, MCPJam's MCP server for agent environments, and follow
the `jamroom` skill in the `mcpjam-backend` repository
(`.agents/skills/jamroom/SKILL.md`). It covers the whole run: building the
environment, starting this app signed in against it, recording evidence and
cleaning up. Without it, say in the PR which signed-in checks you couldn't
run instead of faking them.

## Guest mode

The standard profile uses the hosted guest authority at `app.mcpjam.com`;
it needs no local guest-auth setup. For shared QA, use the approved profile
for that deployment, including its matching guest credentials. Do not mix
one deployment's URLs with another deployment's guest authority or secrets.

For your own development deployment, initialize guest auth explicitly once,
as described in [Guest sessions](../../../CONTRIBUTING.md#guest-sessions):

```bash
npm run dev:setup-guest-auth -w @mcpjam/inspector -- --deployment dev:<deployment-name> \
  --env-file mcpjam-inspector/.env.development.local
```

The setup command validates the development deployment, initializes missing
guest settings without overwriting existing ones, and writes the matching
local profile. Ordinary app startup never changes backend configuration.
Never print profile contents, guest secrets, or access links. If the required
QA profile or member sign-in is unavailable, report which checks are blocked.

## Check the change

1. Before you edit, `open` the screen the change affects (and `--theme dark`)
   to record the before state. Keep that output folder.
2. Make the change, then exercise it with `run`: the happy path, then one
   edge case (empty state, long text, error).
3. `open` the screen again in light and dark. Both themes must read
   correctly, and the RESULT line must say `ok`.
4. For a change that touches shared chrome (sidebar, routing, layout, auth),
   `sweep` and compare its failures with a sweep on `main`.

The Stop hook asks once for this when a turn changed `client/src/` files and no
report under `~/.mcpjam/driver/runs/` is newer. If the app cannot start, say so
in your reply instead of skipping the step silently.

## Evidence a UI pull request attaches

- Before and after screenshots of the changed screen, light and dark.
- The driver's text output for the after `open`, showing `RESULT ok`, or
  each remaining ISSUE line with why it is not caused by this change.
- The steps JSON and output of the `run` that exercises the change.

Attach the screenshots to the PR description. An agent that can't attach
images to a PR uploads them to the Kestral task and links them instead.
Never attach the launcher log or any URL carrying `#token=`.

## Fixing a UI bug: reproduce first

1. Write a steps file that reproduces the bug and run it on the unfixed code.
   It must fail the way the report describes (a `step N FAIL`, an ISSUE line,
   or a screenshot showing the bug). If it does not, you have not found the
   bug yet; do not start fixing.
2. Fix the bug.
3. Run the same steps file again. It must pass, with no new ISSUE lines.
4. Put both outputs in the PR. Add a unit or e2e test for the behavior as
   well when one can cover it; the driver run is the evidence, not the
   regression test.

## Something to connect to

To test against a real MCP server, add one from the Servers page. The
`mcpjam-inspector/test-servers/` directory holds local fixtures; public
servers such as `https://mcp.deepwiki.com/mcp` work for read-only checks.

For a deterministic flow, run `mcp-check-fixture` in a second terminal and add
`http://localhost:3001/mcp` (HTTP, no auth). Its tools are `echo`, `add`
and `server_info`. They have no side effects, so calling one is a safe check:

```bash
cd mcpjam-inspector/test-servers/mcp-check-fixture && npm ci && npm run build && PORT=3001 npm start
```

## When guest sign-in fails

The browser stays on the spinner or shows "Couldn't refresh your session". Look
at the server log and the browser console, then match the symptom:

- **`POST /api/web/guest-session` returns 200, then the console logs "Could not
  decode token… doesn't match any key in the provider's JWKS".** The backend in
  your profile may not trust the guest authority's key. Compare
  `<CONVEX_HTTP_URL>/guest/jwks` and `<authority>/api/web/guest-jwks`. If the
  `kid` is the same but `n` differs, the pairing is broken. For a shared QA
  deployment, ask its operator to check the profile and authority. For your
  own dev deployment, see Guest sessions in `CONTRIBUTING.md`. Do not set
  `GUEST_JWKS_URL`.
- **`POST /api/web/guest-session` returns 403 "Guest session revoked." with no
  cookie sent.** The upstream authority refused the mint. On a preview, this
  can mean the guest-session secret differs between the preview and its
  backend. Check the configured authority and ask the preview operator to
  verify that pairing; the status alone does not prove which setting is wrong.
- **A `staging.mcpjam.com` URL redirects to `cloudflareaccess.com`.** Staging is
  behind Cloudflare Access. A browser or server without access cannot reach it.

Diagnose the pairing or access problem before retrying or changing auth code.
Say which symptom you hit in the PR, and do not report blocked guest checks as passing.

## Reset

- Stop this instance's dev command (Ctrl-C) and any fixture you started. If a
  process remains, inspect the owner of its printed port and stop that process;
  other worktrees can use different ports and must keep running.
- Unless `MCPJAM_SESSION_TOKEN` is set, each start prints a new access link and
  the old one stops working. Open the new link in a fresh incognito window,
  which has no old guest or local-access cookies.
- To use the standard profile without either worktree's overlay, restart with
  `--env-file mcpjam-inspector/.env.local` appended to the launch command from
  the repo root. This selects the committed profile without deleting any QA
  credentials.

## Production build

E2E tests run against `npm run start -w @mcpjam/inspector` (production mode on `:6274`):

```bash
npm run build -w @mcpjam/inspector
npm run test:e2e -w @mcpjam/inspector
```
