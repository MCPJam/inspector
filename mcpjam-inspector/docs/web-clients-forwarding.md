# Web clients forwarding endpoint

Claude web and ChatGPT web (HARN-129) run the vendor's own MCP client. It
reaches the project's MCP server through the Inspector at `/mcp/<connectorId>`
(`server/services/web-clients/forwarding-endpoint.ts`), which:

- forwards Streamable HTTP unchanged: the request body byte for byte, the MCP
  request headers (`accept`, `content-type`, `mcp-session-id`,
  `mcp-protocol-version`, `last-event-id`, `mcp-method`, `mcp-name`,
  `mcp-param-*`, `user-agent`), with the vendor's `authorization` replaced by
  the project's credential. Answers, JSON or SSE, come back unchanged with only
  the server's MCP headers. It is mounted ahead of the global middleware, so no
  security, CORS, indexing or request id header is added;
- gates `tools/call`: a call goes upstream only while a turn window is open on
  the connector (`turn-windows.ts`) and its `approve` hook allows it. Anything
  else passes at any time. A refused call gets a JSON-RPC error with the same id
  and nothing reaches the server. A batch with a refused call is held whole;
- writes every forwarded call to the ledger (`tool-call-ledger.ts`) before
  sending it and settles it from the answer, inside an SSE stream too: `result`,
  `error`, or `lost` when the answer never arrived. With the backend configured
  (hosted), the call is first recorded in the backend's ledger, which recovery
  reads after a restart, and a call that can't be recorded there is refused;
- records every frame on the RPC log bus and the shared sink under
  `web-client:<turnId>` (or `web-client:outside-turn:<digest>`: a capability
  connector's id is its credential, so logs name connectors by a digest), and the
  client's identity from `initialize` or each request's `_meta` (2026-07-28),
  with its user agent.

An `oauth` connector needs an AuthKit access token issued for the connector's
URL, and the user must be allowed to use the project; without one the answer is
`401` with `WWW-Authenticate: Bearer resource_metadata=...`, and the metadata is
served at `/.well-known/oauth-protected-resource/mcp/<connectorId>`. A
`capability` connector treats its unguessable id as the credential and is for
internal tests only. Every connector answers `404` unless
`web-clients-enabled` is on.

## Run it locally behind a tunnel

A local Inspector can register a capability connector for any MCP server it
can reach, so a person or an agent can point Claude web or ChatGPT web at it.

1. Turn the flag on for this process with a flag file, then start the
   Inspector (`npm run dev:worktree -w @mcpjam/inspector -- <N> --no-worker`, or
   `npx @mcpjam/inspector`):

   ```sh
   echo '{"web-clients-enabled": true}' > /tmp/mcpjam-flags.json
   export MCPJAM_FEATURE_FLAGS_FILE=/tmp/mcpjam-flags.json
   ```

2. Register the server. The session token is the one in the Inspector's access
   link (or set `MCPJAM_SESSION_TOKEN` before starting it). Headers are kept in
   the Inspector's memory and never echoed back.

   ```sh
   curl -s http://localhost:6274/api/web-clients/local-connectors \
     -H "X-MCP-Session-Auth: Bearer $SESSION_TOKEN" \
     -H 'content-type: application/json' \
     -d '{"upstreamUrl":"http://localhost:3000/mcp","headers":{"authorization":"Bearer <server token>"}}'
   # {"connectorId":"…","path":"/mcp/…"}
   ```

3. Expose the Inspector's port with any HTTPS tunnel (for example
   `cloudflared tunnel --url http://localhost:6274`) and add
   `https://<tunnel host>/mcp/<connectorId>` as a custom connector in the
   vendor app. The endpoint answers before the Inspector's host allowlist, so
   it answers on the tunnel host; the rest of the Inspector stays behind that
   allowlist and its session token.

4. Tool calls are refused until a turn window is open. The runtime opens one per
   turn; driving the vendor app by hand, open one yourself. It approves only
   the tools in `allowTools`, or every call when the body is `{}`:

   ```sh
   curl -s -X POST http://localhost:6274/api/web-clients/local-connectors/<connectorId>/turn \
     -H "X-MCP-Session-Auth: Bearer $SESSION_TOKEN" -H 'content-type: application/json' \
     -d '{"allowTools":["echo"]}'
   curl -s -X DELETE http://localhost:6274/api/web-clients/local-connectors/<connectorId>/turn \
     -H "X-MCP-Session-Auth: Bearer $SESSION_TOKEN"
   ```

`GET /api/web-clients/local-connectors` lists the registered connectors and
`DELETE /api/web-clients/local-connectors/<connectorId>` removes one. The
registry lives in the process: a restart forgets it, and the vendor app then
needs the connector removed and added again.

## Run Claude web or ChatGPT web from a local Inspector

With the flag file on at startup, a local Inspector runs Claude web and
ChatGPT web turns itself (`local-web-client-environment.ts`): the browser is
Chromium on this machine, on a profile you signed in to by hand, and each
server the client uses gets a capability connector in the registry above.

1. Sign in once per vendor. The profile lives in
   `~/.mcpjam/web-clients/<vendor>-profile`, or under
   `MCPJAM_WEB_CLIENTS_PROFILE_DIR` when you set it to a folder outside the
   repository (a turn refuses a profile inside it):

   ```sh
   npx tsx --tsconfig server/tsconfig.json scripts/web-clients-local-tracer.ts --sign-in --vendor chatgpt
   ```

2. Turn the flag on with the flag file (step 1 of the section above), start a
   tunnel to the Inspector's port, set `MCPJAM_INSPECTOR_PUBLIC_URL` to the
   tunnel's HTTPS URL, then start the Inspector.

3. Run a client whose runtime is Claude web or ChatGPT web. Each turn opens a
   browser window on the profile, adds the connector, sends the prompt and
   closes the window. Set `MCPJAM_WEB_CLIENTS_HEADLESS=true` to run without a
   window. When the vendor asks for a sign-in or a human check, the turn stops
   with "Needs sign-in"; sign in with step 1, then run again.

A server reaches the vendor's app with the URL and headers this Inspector
connects to it with, so a server must be connected over HTTP, with an access
token rather than a refresh token. Each server keeps one connector per vendor,
and a refreshed token replaces the old one in it. One turn at a time uses a
profile: a turn that finds it open in another Inspector or a sign-in window
stops as already running, and you send again once that one is done.

## Opening turn windows from the runtime

```ts
import { webClientTurnWindows } from "server/services/web-clients/turn-windows";

const window = webClientTurnWindows.open({
  connectorId,
  runId,
  approve: async (call) => decide(call), // MCPJam's tool-approval gate
});
try {
  // send the prompt in the vendor app and wait for the reply to finish
} finally {
  webClientTurnWindows.close(window.turnId);
}
```

`approve` receives the tool name, the raw arguments, the JSON-RPC id and
claude.ai's `_meta["claudecode/toolUseId"]`. A `{ allow: false, reason }`
answer is sent to the vendor as the error message, so write `reason` the way
`.agents/skills/ui-copy/SKILL.md` asks. Ledger entries hash the arguments with
`hashPayload(arguments ?? {})`; recovery finds a call with
`webClientToolCallLedger.find({ connectorId, toolUseId })`.
