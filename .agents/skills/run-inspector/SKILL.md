---
name: run-inspector
description: Start the MCPJam Inspector locally, sign the browser in, and check a change in the running app with screenshots. Use for any UI change and whenever a fix needs to be seen working, not only tested.
---

# Run the inspector

## Start it

From the repo root:

```bash
# once per session, if missing
[ -f mcpjam-inspector/.env.development ] || cp mcpjam-inspector/.env.local mcpjam-inspector/.env.development

npm run dev:app -w @mcpjam/inspector
```

- Client: Vite on `http://localhost:5173`. Server: Hono on `:6274`.
- `npm run dev -w @mcpjam/inspector` also starts the platform MCP worker on `:8787`. Use it only when
  the change touches the Home agent's workspace tools or `mcp/`.
- Run it in the background and wait for the client and server to log ready.

## Sign in

The dev command prints a line like:

```
➜ Dev
http://localhost:5173/...<access token>...
Keep this link private: it signs a browser in.
```

Open that exact link in the browser; bare `http://localhost:5173` does not
carry the session token. Never paste the link into a PR, comment or log.

The committed `.env.local` profile uses the hosted guest authority, so guest
mode works without credentials. Signed-in flows (WorkOS) need real accounts;
if the change needs one, say so in the PR instead of faking it.

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
cd mcpjam-inspector/test-servers/mcp-check-fixture && npm ci && npm run build && npm start
```

## When guest sign-in fails

The browser stays on the spinner or shows "Couldn't refresh your session". Look
at the server log and the browser console, then match the symptom:

- **`POST /api/web/guest-session` returns 200, then the console logs "Could not
  decode token… doesn't match any key in the provider's JWKS".** The backend in
  your profile does not trust the guest authority's key. Fetch
  `<CONVEX_HTTP_URL>/guest/jwks` and `<authority>/api/web/guest-jwks`. If the
  `kid` is the same but `n` differs, the pairing is broken. For the shared
  deployment in `.env.local`, an operator has to fix this. For your own dev
  deployment, see Guest sessions in `CONTRIBUTING.md`. Do not set
  `GUEST_JWKS_URL`.
- **`POST /api/web/guest-session` returns 403 "Guest session revoked." with no
  cookie sent.** The upstream authority refused the mint. On a preview, this
  means the guest-session secret differs between the preview and its backend,
  which needs an operator. A preview with its own Convex backend refuses
  guests on purpose.
- **A `staging.mcpjam.com` URL redirects to `cloudflareaccess.com`.** Staging is
  behind Cloudflare Access. A browser or server without access cannot reach it.

None of these is fixed by retrying, by a new access link, or by changing auth
code. Say which one you hit in the PR, and do not report guest checks as passing.

## Reset

- Stop the dev command (Ctrl-C) and any fixture. Free stuck ports with
  `lsof -ti tcp:5173,6274,3001 | xargs kill`.
- Unless `MCPJAM_SESSION_TOKEN` is set, each start prints a new access link and
  the old one stops working. Open the new link in a fresh incognito window,
  which has no old guest or local-access cookies.
- To return to the committed profile, delete `mcpjam-inspector/.env.development`
  and run the copy step again. A `.env.development.local` overrides it, so
  remove or rename that file too.

## Production build

E2E tests run against `npm run start -w @mcpjam/inspector` (production mode on `:6274`):

```bash
npm run build -w @mcpjam/inspector
npm run test:e2e -w @mcpjam/inspector
```
