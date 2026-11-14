---
name: run-inspector
description: Start the MCPJam Inspector locally, sign the browser in, and check a change in the running app with screenshots. Use for any UI change and whenever a fix needs to be seen working, not only tested.
---

# Run the inspector

## Start it

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

Signed-in flows (WorkOS) need real accounts; if the change needs one, say so
in the PR instead of faking it.

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

1. Go to the screen the change affects.
2. Exercise the change: the happy path, then one edge case (empty state, long
   text, error).
3. Take a screenshot in light mode, then switch to dark mode and take another.
   Both themes must read correctly.
4. Check the browser console for new errors.
5. Attach the screenshots to the PR description.

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
