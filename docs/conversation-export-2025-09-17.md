# Interceptor Debug — Conversation Export (2025-09-17)

## Overview

Goal: Get the local MCP interceptor to finish connecting over the HTTP (SSE) transport, matching the behavior of the working reference project. The session initially stalled due to endpoint payload shape, CORS/auth preflights, and proxy header/URL quirks.

## Key Fixes Applied

- Proxy headers
  - Drop `Host` and hop-by-hop headers; let `fetch/undici` set upstream `Host`.
  - server/routes/mcp/interceptor.ts:249–269

- CORS/preflight
  - Explicitly allow `Authorization, Content-Type, Accept, Accept-Language` and set `Vary: Origin, Access-Control-Request-Headers`.
  - server/routes/mcp/interceptor.ts:8–24, 178–188, 191–200

- SSE endpoint (manager adapter)
  - Use a stable absolute base for messages endpoint fallback to avoid path duplication when clients append `/mcp`.
  - server/routes/mcp/manager-http.ts:63–67

- SSE “endpoint” event payload
  - Emit endpoint data as a plain string URL (not JSON) for broad client compatibility; prevents clients from posting to a URL-encoded JSON path.
  - server/routes/mcp/manager-http.ts:88

- Always advertise proxy messages base for manager-backed requests
  - Add `x-mcpjam-endpoint-base` for all GET/HEAD so the adapter emits the correct proxy URL even when `Accept` is `*/*`.
  - server/routes/mcp/interceptor.ts:271

## Why These Fixes Matter

- Host header: Forwarding the original `Host` (often `localhost`) breaks routing at upstream HTTPS targets and can cause silent stalls or 400s. Dropping it lets the HTTP client set the correct host.
- CORS for Authorization: Some clients won’t accept `Access-Control-Allow-Headers: *` for auth. Making it explicit avoids preflight failures that look like hangs.
- SSE endpoint base: When clients append paths (e.g., `/mcp`), building the messages URL from `origin` avoids duplicated segments and broken URLs.
- Endpoint event data shape: Several clients treat `event: endpoint` `data:` as a literal URL string. Emitting JSON caused them to POST to `/interceptor/:id/%7B"url":...%7D` → 404.
- Header always-on hint: Ensures the manager adapter always points the client back through the proxy, independent of `Accept` heuristics.

## Before vs After (Log Highlights)

Before (broken endpoint payload → 404):

```
GET /api/mcp/interceptor/b7f8d0f2/proxy        200
GET /api/mcp/manager-http/weather              200 [stream]
event: endpoint → data: {"url":"https://.../interceptor/b7f8d0f2/proxy/messages?sessionId=..."}
POST /api/mcp/interceptor/b7f8d0f2/%7B%22url%22:...%7D → 404
```

After (string URL payload → correct POST):

```
GET /api/mcp/interceptor/363ecfa5/proxy        200
GET /api/mcp/manager-http/weather              200 [stream]
event: endpoint → data: https://.../interceptor/363ecfa5/proxy/messages?sessionId=...
POST /api/mcp/interceptor/363ecfa5/proxy/messages?sessionId=... → 200
POST /api/mcp/manager-http/weather/messages?sessionId=... → 200
```

## Spec Alignment (MCP HTTP / SSE Transport)

- Initialize returns `{ result: { protocolVersion, capabilities, serverInfo } }` — Confirmed.
- SSE stream stays open with keepalives (`: keepalive ...`) — Confirmed.
- Client POSTs JSON-RPC messages to an endpoint provided via SSE `endpoint` event — Now a plain URL string for compatibility.
- Responses are delivered back via SSE `event: message` lines — Emitted by `manager-http` adapter.

## Remaining Notes and Options

- OAuth discovery 404s are expected if not using OAuth; clients probe `.well-known` endpoints.
- Prefer HTTPS proxy URLs (e.g., via ngrok/loca.lt) for Cursor/Claude to avoid mixed-content.
- Optional hardening (not yet applied):
  - Mirror `Access-Control-Request-Headers` in preflight responses.
  - Tolerant JSON parsing for `/messages` if clients send `text/plain` bodies with JSON.
  - Optionally emit both string and JSON forms of the endpoint event for dual-client compatibility.

## File References

- server/routes/mcp/interceptor.ts:8
- server/routes/mcp/interceptor.ts:178
- server/routes/mcp/interceptor.ts:191
- server/routes/mcp/interceptor.ts:249
- server/routes/mcp/interceptor.ts:271
- server/routes/mcp/manager-http.ts:63
- server/routes/mcp/manager-http.ts:88

## Quick Test Commands

```
# Upstream direct (replace with your server URL)
curl -N -i -X POST 'https://your-mcp.example.com/mcp' \
  -H 'Accept: text/event-stream, application/json' \
  -H 'Content-Type: application/json' \
  --data '{"jsonrpc":"2.0","id":0,"method":"initialize","params":{"protocolVersion":"2025-06-18","capabilities":{}}}'

# Through HTTPS proxy URL (from /create?tunnel=true)
curl -N -i -X POST 'https://<tunnel>/api/mcp/interceptor/<id>/proxy' \
  -H 'Accept: text/event-stream, application/json' \
  -H 'Content-Type: application/json' \
  --data '{"jsonrpc":"2.0","id":0,"method":"initialize","params":{"protocolVersion":"2025-06-18","capabilities":{}}}'
```
