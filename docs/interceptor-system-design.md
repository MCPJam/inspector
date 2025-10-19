# MCPJam Interceptor — System Design & Implementation Notes

This document describes the interceptor architecture that enables MCP clients (Claude, Cursor, etc.) to connect to MCP servers through a single, observable proxy URL. It covers proxying, streaming/SSE handling, stateless compatibility shims, auth injection, stdio bridging, logging, and teardown semantics.

## High‑Level Goals

- Provide a stable HTTPS proxy URL (via ngrok) for any MCP server (HTTP or stdio).
- Observe and log all requests/responses in real time without breaking streaming.
- Support both MCP transports in the wild:
  - Streamable HTTP (SSE + messages side channel)
  - Stateless POST‑only servers (no SSE)
- Work with diverse clients (Claude, Cursor) that handle endpoint payloads differently.
- Allow “Connected Server Mode” (reuse tokens, configs) and “External URL Mode”.
- Make teardown simple: kill proxies for a server on disconnect.

## Components

- **Interceptor API (Hono/Node)** — `server/routes/mcp/interceptor.ts`
  - Creates proxies and computes public proxy URLs via ngrok.
  - Handles `/proxy/:id/*` forwarding and logging.
  - Emits monitor SSE for the UI logging pane.
  - Adds a streamable HTTP shim for stateless servers.
  - Rewrites upstream SSE endpoints to the proxy messages endpoint.
  - Normalizes headers (Accept, hop‑by‑hop), injects auth, and avoids CL+TE conflicts.
- **Interceptor Store** — `server/services/interceptor-store.ts`
  - Persists interceptor entries in memory with:
    - `targetUrl`, `injectHeaders` (Authorization, etc.)
    - Subscriptions for the UI monitor SSE
    - `sessionEndpoints` mapping: `sessionId -> upstream messages URL`
    - Optional `serverId` tag for bulk cleanup
- **Stdio Adapter (optional bridge)** — `server/routes/mcp/adapter-http.ts`
  - Exposes a minimal HTTP JSON‑RPC surface for connected stdio servers.
  - POST-only path for stateless use, plus an optional SSE/messages pair for clients that expect streamable HTTP.
  - Converts Zod schemas to JSON Schema for tools/list.
- **UI**
  - Interceptor tab renders JSON bodies with `react18-json-view` and streams monitor events.
  - Servers tab auto‑tears down proxies on disconnect (`DELETE /interceptor/by-server/:id`).

## Proxy Flow

1. **Create proxy** (`POST /api/mcp/interceptor/create?tunnel=true`)
   - External URL Mode: `targetUrl` is a full MCP HTTP URL.
   - Connected Server Mode: pass `serverId` and optionally `targetUrl`.
     - If HTTP: derive `injectHeaders` (Authorization) from the connected server config.
     - If stdio: set `targetUrl` to the local stdio adapter: `/api/mcp/adapter-http/:serverId`.
   - Start (or reuse) ngrok for the Node API port and return `proxyUrl`.

2. **Use proxy**
   - Clients send MCP traffic to `…/proxy[:id]/…`.
   - The interceptor builds the upstream URL by preserving trailing path/query after `/proxy/:id`.
   - Hop‑by‑hop headers are stripped; `Host` and `Content-Length` are removed; `Accept` is normalized to include both `application/json` and `text/event-stream`.
   - If `injectHeaders` exists and the client didn’t set `Authorization`, add it.

3. **Logging & Streaming**
   - Non‑streaming responses: clone and log body text.
   - Streaming (SSE/NDJSON): don’t drain the stream, but still log content:
     - SSE: tee/parse and append a `200 SSE message` log per `event: message` with the JSON body.
     - Suppress placeholder `[stream]` entries to reduce noise.
   - All responses go through `withCORS()` which also deletes `Content-Length`/`Transfer-Encoding` to avoid dev‑proxy CL+TE errors.

## Streamable HTTP Compatibility

### Upstream SSE (server already streams)

- Rewrite upstream `event: endpoint` to the proxy messages endpoint (`…/proxy/messages?sessionId=…`).
- Record `sessionId -> upstream messages URL` in the store.
- POSTs to `…/proxy/messages` forward to the exact upstream messages URL and return `202` while delivering the real JSON‑RPC response on SSE.

### Stateless Servers (no SSE)

- Provide an **SSE shim** when the client GETs with `Accept: text/event-stream`:
  - Emit `ping` and `endpoint` pointing at the proxy messages URL.
  - Map `sessionId -> upstream base URL` (stateless POST endpoint).
  - POSTs to `…/proxy/messages` forward to the upstream base URL and return `202`.

### Endpoint Payload Nuances (Claude vs Cursor)

- Upstream rewrite: emit a **string** endpoint (broad compatibility; avoids JSON‑in‑path bugs).
- SSE shim (local stream):
  - Detect User-Agent; emit **string‑only** for Claude; **JSON then string** for Cursor/others.

## Header Normalization & CL+TE Avoidance

- Requests: strip hop‑by‑hop headers; drop `Host`/`Content-Length`; normalize `Accept` (JSON + SSE).
- Responses: delete `Content-Length` unconditionally (and `Transfer-Encoding` for our SSE); set keep‑alive/no‑cache for SSE. This prevents `Content-Length can't be present with Transfer-Encoding` in dev proxies.

## Auth Injection (Connected Server Mode)

- Derive `injectHeaders` from saved server config (Authorization from `requestInit.headers` or `oauth.access_token`).
- Apply only if the client didn’t send `Authorization`.
- Enables OAuth‑protected servers to connect transparently via the proxy.

## Stdio Adapter (Optional Bridge)

- `POST /api/mcp/adapter-http/:serverId` — stateless JSON‑RPC.
- `GET /api/mcp/adapter-http/:serverId` — SSE for streamable mode.
- `POST /api/mcp/adapter-http/:serverId/messages` — 202 Accepted; response delivered on SSE.
- Initialize returns spec‑shaped capabilities; tools/list converts Zod → JSON Schema.

## Teardown & Safety

- `DELETE /api/mcp/interceptor/:id` — destroy a proxy, close SSE subscribers, purge session mappings.
- `DELETE /api/mcp/interceptor/by-server/:serverId` — destroy **all** proxies created for a server (used on disconnect).
- Interceptor tab persists proxies in localStorage but validates ids on load; stale proxies are removed and their streams closed.

## Monitor & UI Rendering

- Monitor SSE: `GET /api/mcp/interceptor/:id/stream` pushes history + live logs.
- Interceptor tab renders JSON bodies with `react18-json-view` and falls back to text when parsing fails.
- SSE message logs appear as `200 SSE message` with full JSON payload.

## Common Pitfalls & Fixes

- **CL+TE dev proxy errors** — Always delete `Content-Length` from interceptor responses; delete `Transfer-Encoding` when synthesizing SSE.
- **406 Not Acceptable** — Ensure `Accept` includes `application/json, text/event-stream`.
- **Claude JSON‑in‑path 404** — Emit string endpoint (shim only) for Claude UAs.
- **Cursor not posting after initialize** — Emit JSON endpoint (and string) in shim so it recognizes the messages URL.

## API Reference (Summary)

- Create proxy: `POST /api/mcp/interceptor/create?tunnel=true`
- Proxy traffic: `ALL /api/mcp/interceptor/:id/proxy/*`
- Monitor logs: `GET /api/mcp/interceptor/:id/stream`
- Clear logs: `POST /api/mcp/interceptor/:id/clear`
- Destroy proxy: `DELETE /api/mcp/interceptor/:id`
- Destroy proxies by server: `DELETE /api/mcp/interceptor/by-server/:serverId`
- Stdio adapter (optional):
  - `POST /api/mcp/adapter-http/:serverId`
  - `GET /api/mcp/adapter-http/:serverId`
  - `POST /api/mcp/adapter-http/:serverId/messages`

## Code Pointers

- Proxy handler: `server/routes/mcp/interceptor.ts` → `handleProxy()`
- SSE rewrite & message logging: same file, streaming branch
- SSE shim: same file, `Accept: text/event-stream` (GET/HEAD)
- Store (logs, sessions, bulk destroy): `server/services/interceptor-store.ts`
- Stdio adapter: `server/routes/mcp/adapter-http.ts`
- UI: Interceptor tab `client/src/components/InterceptorTab.tsx`, Servers tab `client/src/components/ServersTab.tsx`
