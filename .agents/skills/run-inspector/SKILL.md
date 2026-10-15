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

# once per session: point guest auth at the QA dev deployment (see "Guest mode")
if [ -n "${MCPJAM_QA_CONVEX_DEPLOYMENT:-}" ] && [ ! -f mcpjam-inspector/.env.development.local ]; then
  d="$MCPJAM_QA_CONVEX_DEPLOYMENT"
  ( umask 077; cat > mcpjam-inspector/.env.development.local <<EOF
CONVEX_URL=https://$d.convex.cloud
VITE_CONVEX_URL=https://$d.convex.cloud
CONVEX_HTTP_URL=https://$d.convex.site
MCPJAM_GUEST_AUTHORITY=backend
MCPJAM_GUEST_SESSION_SHARED_SECRET=$MCPJAM_QA_GUEST_SESSION_SHARED_SECRET
GUEST_SESSION_HASH_PEPPER=$MCPJAM_QA_GUEST_SESSION_HASH_PEPPER
EOF
  )
fi

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

Signed-in flows (WorkOS) need real accounts; if the change needs one, say so
in the PR instead of faking it.

## Guest mode

The committed `.env.local` alone does not give a working guest. It points at
the staging backend but leaves the guest authority at `app.mcpjam.com`, so
staging rejects every guest token (same key ID, different key) and the app
stays "reconnecting". Staging's own authority sits behind Cloudflare Access.

Guest QA therefore needs a Convex development deployment initialized with
`npm run dev:setup-guest-auth`. The launcher reads it from
`mcpjam-inspector/.env.development.local`, which overrides the whole backend
group of `.env.local`; it ignores these settings as shell variables. The
start step above writes that file when these are set (Devin has them as
secrets):

- `MCPJAM_QA_CONVEX_DEPLOYMENT`: the deployment name, without `dev:`.
- `MCPJAM_QA_GUEST_SESSION_SHARED_SECRET` and
  `MCPJAM_QA_GUEST_SESSION_HASH_PEPPER`: that deployment's
  `GUEST_SESSION_SHARED_SECRET` and `GUEST_SESSION_HASH_PEPPER`.

If they are not set, guest flows cannot be checked live; say so in the PR.
Never print the file or these values.

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

## Production build

E2E tests run against `npm run start -w @mcpjam/inspector` (production mode on `:6274`):

```bash
npm run build -w @mcpjam/inspector
npm run test:e2e -w @mcpjam/inspector
```
