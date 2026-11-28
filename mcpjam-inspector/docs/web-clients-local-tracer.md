# Local Claude tracer

A one-command check that Claude web (claude.ai) reaches an MCP server through
MCPJam's forwarding endpoint, run by a person on a laptop with their own
Claude account. It sends one harmless prompt and prints what crossed the wire.
Evidence from it is "live vendor"; nothing else in the repository is.

## What it does

1. Starts a recording MCP server with one `echo` tool, so no real server is
   touched and the receipt shows exactly what Claude's MCP client sent.
2. Starts the Inspector's forwarding endpoint (`createWebConnectorEndpoint`)
   in its own process with web clients enabled, and registers a capability
   connector to that server. The connector id is the credential, so the
   script makes a fresh random one each run and never prints it.
3. Opens Chromium, headed, on a persistent profile outside the repository
   (default `~/.mcpjam/web-clients/claude-profile`).
4. Drives claude.ai with the same page module MCPJam's runtime uses: checks
   the account is signed in, adds the connector (`MCPJam tracer`, pointed at
   your tunnel), opens a new chat, enables the connector, sends the prompt
   once, answers Claude's own tool prompt with Always allow, waits for the
   reply to finish and reads the saved conversation.
5. Prints sanitized evidence: the run and turn ids, the conversation id, the
   reply's finish signals, the tool calls the conversation shows, the ledger
   entries (tool name, tool use id, state, a prefix of the argument hash,
   times) and the upstream receipt (methods, client name and version, tool
   name, argument names, tool use id, user agent). No email, cookie, token or
   argument value is printed.

The turn window only allows the tracer's `echo` tool.

## Run it

Use the Node version in `mcpjam-inspector/.nvmrc`. Set up the checkout once,
since the server code imports generated files: from the repository root run
`npm ci`, then in `mcpjam-inspector/` run
`npm run sdk:build && npm run bundle:all`. Install Chromium for Playwright if
you have not:

```sh
npx playwright install chromium
```

Start a tunnel to the tracer's port (6280 by default), for example:

```sh
cloudflared tunnel --url http://localhost:6280
```

Then, from `mcpjam-inspector/`, with the tunnel's HTTPS URL:

```sh
npx tsx --tsconfig server/tsconfig.json scripts/web-clients-local-tracer.ts \
  --tunnel-url https://<your tunnel host>
```

Options: `--port` (default `6280`), `--profile` (a folder outside the
repository; by default `~/.mcpjam/web-clients/<vendor>-profile`, or under
`MCPJAM_WEB_CLIENTS_PROFILE_DIR`).

## Needs sign-in

The tracer never answers a "Verify you are human" check, a password, a
verification code or a consent page. When claude.ai shows one, or the profile
is signed out, it prints one line starting with `Needs sign-in` and exits with
code 2. Sign in by hand on the profile the tracer used. If you ran it with
`--profile <dir>`, add the same `--profile <dir>` here:

```sh
npx tsx --tsconfig server/tsconfig.json scripts/web-clients-local-tracer.ts --sign-in
```

Sign in to claude.ai in the window that opens, close it, then run the tracer
again. The window is Playwright's Chromium started as a plain browser, with no
automation flags or remote control, so claude.ai's human check treats it like
any browser; answer the check yourself. The profile keeps the session for later runs. Add `--vendor chatgpt` to
sign in to ChatGPT instead; the tracer itself drives Claude web only, but a
local Inspector runs either vendor on these profiles (see
`web-clients-forwarding.md`).

## Notes

- Claude's Free plan allows one custom connector. The tracer only removes a
  connector whose name starts with `MCPJam`; if another custom connector is
  there, it stops and says so.
- The forwarding endpoint must be in your checkout; until it is, the tracer
  says so and exits.
- To drive claude.ai by hand against a running Inspector instead, use the
  local connector routes in `web-clients-forwarding.md`.
