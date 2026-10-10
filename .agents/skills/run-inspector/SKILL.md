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
- `npm run dev` also starts the platform MCP worker on `:8787`. Use it only when
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

## Production build

E2E tests run against `npm run start` (production mode on `:6274`):

```bash
npm run build -w @mcpjam/inspector
npm run test:e2e -w @mcpjam/inspector
```
