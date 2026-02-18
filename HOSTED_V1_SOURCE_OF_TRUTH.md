# MCPJam Hosted V1 Source of Truth
---

## 1) Product Outcome

Hosted V1 delivers a production hosted path for:
1. Server validation (`Connected` means validated and executable in hosted mode).
2. Chat V2 tool execution over selected servers.
3. MCP Apps + ChatGPT Apps widget rendering.

Hosted V1 is explicitly **ephemeral** for chat/widget runtime state.

---

## 2) Core Product Semantics

1. Hosted execution is stateless per request:
   - authorize -> resolve server config -> connect -> execute -> disconnect.
2. For `POST /api/web/chat-v2`, "stateless per request" means:
   - open at most one MCP connection per `serverId` for that request,
   - reuse that connection across all steps/tool calls in the same stream,
   - disconnect all request-scoped connections on finish, error, or client abort.
3. Widget/chat runtime state is session-scoped and non-durable.
4. Restart and cross-instance continuity are **not** V1 requirements.
5. `localStorage` is optional UX cache only, never system-of-record.

---

## 3) In Scope

1. Hosted route family under `/api/web/*`.
2. Hosted auth via bearer JWT (WorkOS-issued), validated by Convex.
3. Hosted strict mode route partitioning and legacy path blocking.
4. Hosted chat-v2 streaming with request-scoped MCP execution.
5. Hosted chat-v2 streaming via existing Convex `/stream` endpoint and `handleMCPJamFreeChatModel` agentic loop.
6. Hosted tools/resources/prompts operations.
7. Hosted widget-content paths for MCP Apps and ChatGPT Apps.
8. Hosted observability, rate limits, and rollout guardrails.
9. Hosted OAuth proxy for MCP servers that require OAuth authentication (CORS bypass for metadata discovery, client registration, and token exchange).

---

## 4) Out of Scope (V1)

1. Durable widget/file artifact platform.
2. Restart-proof or multi-instance-proof widget/file continuity.
3. Tasks, elicitation, tunnels, adapter-http, manager-http, OAuth debugger in hosted mode.
4. ~~OAuth-required MCP server connections in hosted mode.~~ **Moved to in-scope** — see §3 #9.
5. Share links and shared transcripts.
6. Connection pooling across requests.
7. Resource templates in hosted mode.
8. Direct OpenRouter streaming from Inspector (Convex `/stream` is the primary hosted chat path; direct Inspector-side streaming deferred to V1.1).
9. Inspector-side JWT validation (JWKS, `jose`, issuer/audience checks). Convex owns all JWT validation.
10. SSRF outbound guard on MCP connections.
    - The implementation is trivial (~50 lines, undici `connect.lookup` + `ipaddr.js`), but blocking private/loopback/link-local IP ranges would break legitimate MCP servers that users run on private networks, local machines, or behind tunnels. These are common MCP deployment patterns that Hosted V1 has no way to distinguish from malicious targets.
    - The residual risk is mitigated by workspace membership: only authenticated members of a workspace can register server URLs, and every connection requires Convex-verified authorization. The threat is "compromised account → SSRF", not "unauthenticated user → SSRF".
    - Planned for V1.1 with an allowlist/policy mechanism that lets workspaces opt in without breaking their existing server configurations.

---

## 5) Locked Architecture Decisions

1. Hosted request identity uses `workspaceId + serverId`.
2. Hosted auth uses `Authorization: Bearer <jwt>`.
3. Hosted mutating APIs accept auth only from bearer header.
4. Hosted strict mode bypasses legacy session-token machinery.
5. No durable artifact data model in Hosted V1.
6. Hosted `/api/web/chat-v2` reuses `handleMCPJamFreeChatModel` and the existing Convex `/stream` endpoint as-is. No separate OpenRouter stream provider or adapter in the Inspector. Rate limiting, usage tracking, and model allowlisting are handled by Convex.
7. OpenRouter credentials exist only in the Convex server environment. The Inspector never holds, needs, or accepts OpenRouter API keys. Clients never send provider API keys.
8. Chat request execution matches local-provider semantics for connection lifecycle:
   - per-request connection reuse across `maxSteps` and tool calls,
   - no connection reuse across different HTTP requests.
9. **JWT validation is fully delegated to Convex.** The inspector forwards the user's WorkOS JWT in the `Authorization` header. Convex validates it with `ctx.auth.getUserIdentity()` using the existing WorkOS auth config (RS256, JWKS, issuer, audience — all handled by Convex internally). Convex resolves the user from the JWT `sub` claim (WorkOS external ID) via the `users.by_externalId` index. The inspector never validates JWTs, never fetches JWKS, and never sends a `userId`. No service-to-service token. Every hosted request hits Convex for auth; this is acceptable in V1 because the auth call piggybacks on the `serverConfig` resolution round-trip that is required regardless.
10. Rollback is env var change + Railway release rollback. No in-app breakglass mechanism.
11. All hosted error responses use shape: `{ "code": "<ERROR_CODE>", "message": "<human-readable detail>" }`. The baseline error codes are:
    - `UNAUTHORIZED` — missing or invalid bearer token (401).
    - `FORBIDDEN` — authenticated but not a member of the target workspace (403).
    - `NOT_FOUND` — server or resource does not exist or does not belong to the workspace (404).
    - `VALIDATION_ERROR` — request body fails schema validation (400).
    - `RATE_LIMITED` — request rejected by rate limiter (429).
    - `FEATURE_NOT_SUPPORTED` — caller invoked a feature explicitly out of scope for hosted mode (400).
    - `SERVER_UNREACHABLE` — MCP server connection or initialize handshake failed (502).
    - `TIMEOUT` — MCP connection or call exceeded configured timeout (504).
    - `INTERNAL_ERROR` — unexpected server-side failure (500).
12. Widget content in hosted mode is fetched from the MCP server per request and held in-memory for the request lifetime only. No cross-request or cross-instance widget caching.
13. **Request-scoped MCP execution uses ephemeral `MCPClientManager` instances.** No new class is required. The existing `MCPClientManager` from `@mcpjam/sdk` already supports this pattern natively:
    - **Create:** `new MCPClientManager(serverConfigs, minimalOptions)` — the constructor eagerly fires `connectToServer()` for each config in parallel.
    - **Use:** Route handlers call `manager.getToolsForAiSdk(serverIds)` and `handleMCPJamFreeChatModel({ mcpClientManager: manager, ... })` exactly as local mode does. `ensureConnected()` inside these methods awaits the in-flight connection promises from the constructor.
    - **Cleanup (non-streaming routes):** `finally { await manager.disconnectAllServers() }` at the route level — tears down all connections and clears state.
    - **Cleanup (streaming routes — chat-v2):** Route-level `finally` is **not safe** for streaming responses. `handleMCPJamFreeChatModel` returns a `Response` immediately while the `execute` callback in `createUIMessageStream` continues asynchronously. A route-level `finally` would kill connections before the stream finishes. Instead, cleanup must be wired via the `onFinish` callback in `createUIMessageStream`, which fires when the stream completes or the client aborts. The hosted chat route passes an `onStreamComplete: () => manager.disconnectAllServers()` callback to the handler, which invokes it in `onFinish`. This is the only safe teardown point for streaming responses.
    - For single-server routes (`tools/list`, `resources/read`, etc.), the ephemeral manager is created with one server config. For `chat-v2`, it is created with all `selectedServerIds` configs.
    - `handleMCPJamFreeChatModel` already accepts `mcpClientManager` as a parameter and `tools` as pre-wired AI SDK tools whose execute functions close over the manager reference. Passing an ephemeral manager requires a small addition: an optional `onStreamComplete` callback in `MCPJamHandlerOptions`, invoked in `createUIMessageStream`'s `onFinish`. No other changes to the stream handler.
    - Chat-v2 multi-step reuse works automatically — the manager holds connections until `disconnectAllServers()` is called, so all steps within a single request share the same connections.
    - Connection caching across requests (keyed by `{userId, workspaceId, serverId}` with TTL) is a V1.1 optimization. V1 pays the per-request connect/disconnect latency cost (~1-5s overhead) in exchange for complete isolation and statelessness.
14. **Hosted OAuth uses a CORS proxy with HTTPS-only enforcement.** The MCP Auth spec mandates HTTPS for all authorization server endpoints. The client-side MCP SDK OAuth flow (metadata discovery, client registration, token exchange) cannot reach these endpoints directly due to CORS. The inspector provides authenticated proxy routes (`/api/web/oauth/proxy`, `/api/web/oauth/metadata`) that forward requests to the target OAuth/authorization server. These routes:
    - Require bearer JWT authentication (same as all `/api/web/*` routes).
    - Enforce **HTTPS-only** targets — HTTP URLs are rejected with 400. This is both spec-compliant and prevents SSRF to internal HTTP services.
    - Share implementation with the local-mode `/api/mcp/oauth/*` routes via `server/utils/oauth-proxy.ts` (code deduplication). The local routes retain HTTP support for local development.
    - The OAuth flow itself runs entirely in the client (MCP SDK `auth()` function). The proxy only handles CORS bypass. OAuth tokens are stored client-side in `localStorage` and sent to execution routes via `oauthAccessToken`/`oauthTokens` request fields.
    - Workspace/server-scoped URL restriction (limiting proxy targets to discovered OAuth endpoints only) is deferred to V1.1. The residual risk is mitigated by: authentication (bearer JWT required), HTTPS-only enforcement, and Railway's isolated container network (no internal HTTPS services reachable).

---

## 6) API Contract (Inspector)

All routes require bearer JWT (forwarded to Convex for validation). No exceptions — the hosted ChatGPT Apps renderer uses the MCP Apps pattern (authenticated POST + `SandboxedIframe` injection) to avoid unauthenticated iframe `src` URLs.

1. `POST /api/web/servers/validate`
   Request: `{ workspaceId, serverId, oauthAccessToken? }`
   Behavior: Authorizes via Convex, then connects to the MCP server, runs `initialize`, and disconnects. Returns success if the server is reachable and responds to the MCP handshake. This is a full executor round-trip. For OAuth-enabled servers, `oauthAccessToken` is required and injected as `Authorization: Bearer` on the MCP connection.
2. `POST /api/web/chat-v2`
   Request: `ChatV2Request + { workspaceId, selectedServerIds: string[], oauthTokens?: Record<string, string> }`
   Note: The hosted field name is `selectedServerIds`. The existing local-mode `ChatV2Request` uses `selectedServers`. Hosted routes use `selectedServerIds` exclusively; the local-mode field name is unchanged. `oauthTokens` maps server IDs to OAuth access tokens for servers that require OAuth.
3. `POST /api/web/tools/list`
   Request: `{ workspaceId, serverId, oauthAccessToken?, modelId?, cursor? }`
4. `POST /api/web/tools/execute`
   Request: `{ workspaceId, serverId, oauthAccessToken?, toolName, parameters }`
5. `POST /api/web/resources/list`
   Request: `{ workspaceId, serverId, oauthAccessToken?, cursor? }`
6. `POST /api/web/resources/read`
   Request: `{ workspaceId, serverId, oauthAccessToken?, uri }`
7. `POST /api/web/prompts/list`
   Request: `{ workspaceId, serverId, oauthAccessToken?, cursor? }`
8. `POST /api/web/prompts/list-multi`
   Request: `{ workspaceId, serverIds: string[], oauthTokens?: Record<string, string> }`
   Behavior: Batch-lists prompts for multiple servers in one call. Required by the chat input prompts popover.
9. `POST /api/web/prompts/get`
   Request: `{ workspaceId, serverId, oauthAccessToken?, promptName, arguments? }`
   Behavior: Fetches prompt content with user-supplied arguments. Required for prompt execution.
10. `POST /api/web/apps/mcp-apps/widget-content`
    Request: existing payload + `{ workspaceId, serverId, oauthAccessToken? }`
11. `POST /api/web/apps/chatgpt-apps/widget-content`
    Request: `{ workspaceId, serverId, oauthAccessToken?, uri, toolInput, toolOutput, toolResponseMetadata, toolId, toolName, theme, cspMode, locale?, deviceType? }`
    Response: `{ html, csp, prefersBorder, closeWidget, widgetDescription? }`
    Behavior: Single-step ChatGPT Apps widget content fetch. Server fetches the resource from the MCP server, builds the HTML with injected runtime config, extracts CSP metadata, and returns everything as JSON. The hosted client renderer injects the HTML into a `SandboxedIframe` via `postMessage`/`srcdoc` (same pattern as MCP Apps), avoiding the need for unauthenticated iframe `src` URLs. This replaces the local-mode 3-step flow (`widget/store` → `widget-html/:toolId` → `widget-content/:toolId`) which requires server-side widget state and unauthenticated GET endpoints.
12. `POST /api/web/oauth/proxy`
    Request: `{ url, method?, body?, headers? }`
    Behavior: Authenticated CORS proxy for OAuth token exchange and client registration. HTTPS-only targets enforced. Mirrors `/api/mcp/oauth/proxy` but requires bearer JWT.
13. `GET /api/web/oauth/metadata?url=https://...`
    Behavior: Authenticated CORS proxy for OAuth metadata discovery. HTTPS-only targets enforced. Mirrors `/api/mcp/oauth/metadata` but requires bearer JWT.

Max request body: 1MB for all JSON endpoints.

### Hosted chat execution mode

1. Hosted `POST /api/web/chat-v2` reuses `handleMCPJamFreeChatModel` as-is.
   - The existing agentic loop (step → stream via Convex `/stream` → collect tool calls → execute locally → repeat) is unchanged.
   - LLM inference goes through Convex `/stream` (same path as local mode). Rate limiting, usage tracking, model allowlisting, and OpenRouter key management are all handled by Convex.
   - The only difference from local mode is: hosted auth (bearer JWT forwarded to Convex), MCP tools resolved from hosted server connections (via `/web/authorize`), and hosted-only request fields (`workspaceId`, `selectedServerIds`).
2. Client contract is unchanged: clients never send provider API keys.
3. Connection lifecycle for chat requests:
   - Create ephemeral `MCPClientManager` with configs for all `selectedServerIds` (connections start eagerly in parallel via constructor).
   - `getToolsForAiSdk()` awaits in-flight connection promises via `ensureConnected()`.
   - Reuse for all subsequent tool calls / `maxSteps` iterations in the same stream.
   - Cleanup via `onFinish` callback in `createUIMessageStream` (NOT route-level `finally` — the Response is returned before the stream completes). `onFinish` fires on stream completion or client abort, then calls `manager.disconnectAllServers()`.

### Hosted upload/file behavior

Default V1 behavior: unsupported.
1. `POST /api/web/apps/chatgpt-apps/upload-file` → explicit unsupported error.
2. `GET /api/web/apps/chatgpt-apps/file/:id` → explicit unsupported error.

If temporarily enabled for test/staging, behavior is best-effort ephemeral only.

---

## 7) Backend Service Contract (Convex)

Convex endpoints for hosted inspector. The inspector forwards the user's WorkOS JWT in the `Authorization` header. Convex validates it with `ctx.auth.getUserIdentity()` using the existing WorkOS auth config — no separate service token. Convex resolves the user from the JWT `sub` claim via the `users.by_externalId` index.

All required Convex infrastructure already exists:
- `users` table with `by_externalId` index.
- `workspaceMembers` table with `by_workspace_and_user`, `by_workspace`, `by_user`, `by_email` indexes.
- Flat `servers` table with `transportType`, `url`, `headers`, `workspaceId` FK, and `by_workspace` index.
- Authorization helpers in `lib/authorization.ts` (`requireWorkspaceRole`, `hasWorkspaceRole`, role ranking).
- HTTP router (`http.ts`) with existing routes (`/ensureUser`, `/stream`, `/models`, `/tunnels/*`) and CORS helpers.
- **CORS note:** The Convex `corsHeaders()` helper in `http.ts` currently whitelists only localhost origins **and falls back to `Access-Control-Allow-Origin: *` for non-allowlisted origins** (line 17). This directly violates the "exact origins only" security requirement (§9.6). The `/web/authorize` endpoint must: (a) add the production hosted origin to the allowlist, and (b) fix the fallback to **omit the CORS header entirely** (or return `403`) for non-allowlisted origins instead of falling back to `*`. This is a backend deployment prerequisite.

1. `POST /web/authorize`
   Request: `{ workspaceId, serverId }`
   Implementation: new HTTP route handler (~60 lines) following existing patterns:
   - `ctx.auth.getUserIdentity()` → `users.by_externalId(identity.subject)` → `workspaceMembers.by_workspace_and_user(workspaceId, userId)` → `db.get(serverId)` + verify `server.workspaceId` matches.
   - **Must reject servers with out-of-scope configurations:** `transportType === "stdio"` → error (hosted cannot spawn subprocesses, §4.3). This check uses the existing `servers` table field (`transportType`).
   - Returns `{ authorized, role, serverConfig }` where `serverConfig` contains: `{ transportType, url, headers, useOAuth }`. The `useOAuth` flag tells the inspector whether the server requires OAuth authentication — when `true`, the inspector must provide an `oauthAccessToken` in execution requests.
   - Sensitive fields (headers containing auth tokens) transit over HTTPS (Convex endpoints are HTTPS by default).

Not in V1:
1. `/web/artifacts/create`
2. `/web/artifacts/resolve`

Chat note:
1. Hosted chat mode uses Convex `/stream` for LLM inference (same as local mode). No separate streaming path needed in V1.
2. Convex stays responsible for hosted authz, config resolution, rate limiting, and usage tracking.

---

## 8) Frontend Implementation Strategy

Hosted support must be implemented with isolation and reuse, not full duplication.

### Required structure
1. New hosted API layer:
   - `client/src/lib/apis/web/*`
2. New hosted hooks:
   - `client/src/hooks/hosted/*`
3. New hosted containers:
   - `client/src/components/hosted/*`

### Reuse policy
1. Reuse shared presentational components from existing chat/widget renderers.
2. Keep hosted-only orchestration, auth, and route behavior in hosted containers/hooks.
3. Do not clone full large files (`chatgpt-app-renderer.tsx`, `mcp-apps-renderer.tsx`, etc.).
4. Local/Electron/Docker callsites remain unchanged.

### Hosted ChatGPT Apps renderer
The hosted ChatGPT Apps renderer is a **new component** in `client/src/components/hosted/` that replaces the local-mode 3-step iframe flow with the MCP Apps rendering pattern:
1. Fetches widget content via authenticated `POST /api/web/apps/chatgpt-apps/widget-content` (bearer JWT included).
2. Receives `{ html, csp, prefersBorder, closeWidget }` as JSON.
3. Injects HTML into the existing `SandboxedIframe` component via `postMessage`/`srcdoc`.

This eliminates unauthenticated GET endpoints, server-side widget state, and the iframe auth blocker entirely. The existing `chatgpt-app-renderer.tsx` is unchanged — local mode continues to use its current 3-step flow. The hosted renderer is a separate, simpler component that reuses `SandboxedIframe` and the shared presentational shell.

---

## 9) Security Requirements

1. Hosted strict route partition:
   - `/api/session-token` returns `410` in hosted strict mode.
   - `/api/mcp/*` returns `410` in hosted strict mode.
   - `/api/apps/*` returns `410` in hosted strict mode. These legacy routes are explicitly unprotected by session auth (designed for sandboxed iframes). In a multi-tenant hosted environment they expose cross-user widget data, file uploads, and MCP resource access without any auth. Hosted mode uses `/api/web/apps/*` instead.
2. Enforce cross-workspace authorization on every hosted execution path (via Convex `/web/authorize`).
3. Validate and normalize hosted inputs with schema-first middleware.
4. Max request body: 1MB for all hosted JSON endpoints. Enforced via Hono `bodyLimit` middleware (`hono/body-limit`) applied to all `/api/web/*` routes.
5. Return explicit structured errors for unsupported hosted features using locked error shape and error codes (see section 5, item 11).
6. Hosted CORS restricts `Access-Control-Allow-Origin` to exact origins from `WEB_ALLOWED_ORIGINS`.
7. Hosted OAuth proxy (`/api/web/oauth/*`) enforces HTTPS-only targets. HTTP URLs are rejected with 400. This prevents SSRF to internal HTTP services (cloud metadata endpoints, internal APIs). See §5 #14.

---

## 10) Environment Contract

Required:
1. `VITE_MCPJAM_HOSTED_MODE=true`
2. `VITE_MCPJAM_HOSTED_STRICT_SECURITY=true`
3. `CONVEX_HTTP_URL` (Convex HTTP endpoint — required for `/web/authorize` calls and `/stream` LLM inference)
4. `WEB_ALLOWED_ORIGINS` (comma-separated exact origins for CORS)
5. `WEB_CONNECT_TIMEOUT_MS` (default 10000)
6. `WEB_CALL_TIMEOUT_MS` (default 30000)
7. `WEB_STREAM_TIMEOUT_MS` (default 120000)
8. `WEB_RATE_LIMIT_ENABLED=true`

Optional:
(none)

Not required in V1:
1. `WEB_ARTIFACT_SIGNING_KEY`
2. `WEB_JWKS_URL` (Convex handles JWKS internally)
3. `WEB_AUTH_ISSUER_ALLOWLIST` (Convex handles issuer validation)
4. `WEB_AUTH_AUDIENCE` (Convex handles audience validation)
5. `WEB_OPENROUTER_API_KEY` (Convex `/stream` handles OpenRouter; Inspector never calls OpenRouter directly)
6. `WEB_OPENROUTER_BASE_URL` (same reason as above)

---

## 11) Test Plan (V1)

### Unit
1. Header-only auth enforcement on mutating hosted routes (bearer present → forwarded; bearer missing → 401).
2. Schema parse-once middleware behavior.
3. Hosted `tools/execute` rejects unsupported parameters (`taskOptions` etc. if out of scope).
4. Hosted chat mode refuses startup if `CONVEX_HTTP_URL` is missing (required for `/stream` hop).
5. Chat logging redacts provider auth headers and secrets.
6. Request body over 1MB rejected.

### Integration
1. Hosted strict startup disables legacy session-token path.
2. `/api/mcp/*` blocked in hosted strict mode.
3. `/api/apps/*` blocked in hosted strict mode (legacy unprotected widget/file routes).
4. Cross-workspace access denied for all hosted execution routes.
5. Request-scoped connect/execute/disconnect ordering.
6. Chat cleanup on stream abort/error.
7. Hosted chat streams successfully end-to-end via Convex `/stream`.
8. `chat-v2` with `maxSteps > 1` reuses the same per-server connection within the request.
9. Repeated tool calls to the same `serverId` in one stream do not reconnect between calls.
10. Different requests do not share MCP connections.
11. Convex `/web/authorize` rejects requests with invalid/expired JWT.
12. Convex `/web/authorize` denies non-member access to workspace.
13. Convex `/web/authorize` denies access when server does not belong to workspace.
14. Convex `/web/authorize` rejects `transportType=stdio` servers.
15. Convex `/web/authorize` returns `useOAuth` flag in `serverConfig` for OAuth-enabled servers.
16. Hosted OAuth proxy rejects HTTP target URLs with 400 (HTTPS-only enforcement).
17. Hosted OAuth proxy requires bearer JWT authentication.
18. OAuth-enabled server validation succeeds when `oauthAccessToken` is provided.
19. Chat-v2 with OAuth-enabled servers injects `Authorization: Bearer` on MCP connections using `oauthTokens` map.
20. Chat-v2 `onFinish` cleanup fires `disconnectAllServers()` on normal completion.
21. Chat-v2 `onFinish` cleanup fires `disconnectAllServers()` on client abort.

### E2E
1. Workspace member validates server, chats, executes tools, sees widget output.
2. Non-member gets forbidden.
3. Unsupported hosted controls hidden in UI and blocked server-side.

Removed from V1:
1. Artifact durability across restart.
2. Cross-instance artifact continuity assertions.
3. Inspector-side JWT validation matrix (valid, expired, wrong issuer, wrong audience, bad signature) — covered by Convex.
4. JWKS cache behavior tests — not applicable, Convex handles internally.
5. SSRF guard unit tests — deferred with SSRF guard (see section 4, item 10).
6. OpenRouter → UIMessageChunk adapter tests — not applicable, hosted chat reuses existing Convex `/stream` path.
7. `WEB_OPENROUTER_API_KEY` missing rejection test — not applicable, Inspector never holds OpenRouter keys.

---

## 12) Implementation Phases

1. Vertical slice:
   - `validate → tools/list → tools/execute` with request-scoped lifecycle (ephemeral `MCPClientManager` per request).
2. Hosted strict partition + auth middleware (bearer extraction + Convex forwarding).
3. Convex `/web/authorize` HTTP route (~60 lines, all schema/indexes/helpers exist) + Convex CORS allowlist update for production hosted origin.
4. Hosted route family (`/api/web/*`) for tools/resources/prompts.
5. Hosted chat route: wire `POST /api/web/chat-v2` to call `handleMCPJamFreeChatModel` with hosted auth + hosted MCP tools (no new adapter needed — reuses Convex `/stream` as-is).
6. Widget-content hosted paths (ephemeral, per-request fetch from MCP server).
7. Client hosted API + hosted containers/hooks wiring.
8. Hardening: logs, request IDs, rate limits, body size enforcement (`hono/body-limit`), soak, canary.

---

## 13) Rollout and Rollback

1. Deploy Convex `/web/authorize` endpoint first.
2. Deploy backend `/web/*` support.
3. Deploy hosted strict inspector in staging.
4. Execute test suite and soak.
5. Canary production rollout.
6. Rollback: set `VITE_MCPJAM_HOSTED_STRICT_SECURITY=false` and redeploy, or Railway release rollback.

---

## 14) Acceptance Criteria

1. Authorized workspace members can validate servers and run hosted chat/tools/widgets.
2. Hosted requests are stateless and isolated per request.
3. Legacy session-token auth is inactive in hosted strict mode.
4. Unsupported hosted features are hidden in UI and blocked server-side with explicit errors.
5. Cross-workspace leakage tests pass with zero critical findings.
6. Hosted behavior is explicitly documented as ephemeral (non-durable).
7. Hosted `chat-v2` reuses per-server connections for the duration of a single request and always tears them down at request end.
8. OAuth-enabled MCP servers can be validated and used in hosted chat/tools via the hosted OAuth proxy.

---

## 15) Change Control

Any change to Hosted V1 scope, semantics, API contract, or acceptance criteria must update this file first.
No other document is authoritative for Hosted V1 planning or delivery.

---

### Changes from previous version

| Section | What changed | Why |
|---------|-------------|-----|
| §3 In Scope #2 | Added "validated by Convex" | Inspector doesn't validate JWTs itself |
| §4 Out of Scope #9 | Added inspector-side JWT validation to out-of-scope | Convex owns all JWT validation; no `jose`, no JWKS in inspector |
| §5 #6 | Changed from "direct server-side OpenRouter streaming" to "reuses `handleMCPJamFreeChatModel` with pluggable stream source" | Investigation confirmed the agentic loop is decoupled from its stream source; parameterizing it avoids a new adapter and refactor |
| §5 #9 | Expanded to explain delegation model and why per-request Convex auth is acceptable | Clarifies that auth piggybacks on the `serverConfig` round-trip |
| §6 Chat mode | Rewrote to describe hosted chat execution mode | Describes the actual implementation path, not a vague "direct streaming" concept (note: OpenRouter adapter references later removed in freemcpjam scope cut) |
| §7 | Added inventory of existing Convex infrastructure | Investigation confirmed all tables, indexes, and helpers exist — no schema work needed |
| §9 #7 | Removed JWKS caching requirement | Convex handles JWKS internally |
| §9 #9 | Removed `WEB_AUTH_AUDIENCE` requirement | Convex handles audience validation |
| §10 | Removed `WEB_JWKS_URL`, `WEB_AUTH_ISSUER_ALLOWLIST`, `WEB_AUTH_AUDIENCE` from required | Moved to "Not required in V1" with rationale |
| §11 Unit #1-2 | Removed JWT validation matrix and JWKS cache tests | Covered by Convex, not inspector responsibility |
| §11 Unit #9 | Added UIMessageChunk adapter test | New component needs coverage |
| §11 Removed | Added items 3-4 explaining what was removed and why | Traceability |
| §12 #2 | Simplified to "bearer extraction + Convex forwarding" | No JWKS cache to build |
| §12 #3 | Added effort estimate and existing-infrastructure note | ~60 lines, all building blocks exist |
| §12 #6 | Changed from "direct-provider adapter" to "parameterize handleMCPJamFreeChatModel" | Reuse over rebuild |
| §13 #1 | Added "Deploy Convex `/web/authorize` endpoint first" | Convex endpoint is a prerequisite for all inspector-side work |

### Freemcpjam scope cut (2026-02-16)

Switched hosted chat from "direct OpenRouter streaming from Inspector" to reusing the existing `handleMCPJamFreeChatModel` + Convex `/stream` path as-is. This eliminates the need for `WEB_OPENROUTER_API_KEY` on the Inspector, the `OpenRouterStreamProvider`, and the `OpenRouter → UIMessageChunk` adapter — cutting the largest new-code surface from the chat path.

| Section | What changed | Why |
|---------|-------------|-----|
| §3 #5 | Changed "direct server-side model streaming" to "via existing Convex `/stream` and `handleMCPJamFreeChatModel`" | Reuse over rebuild; Convex already handles rate limiting, usage tracking, model allowlist |
| §4 #8 | Changed "Convex-proxy chat fallback mode" to "Direct OpenRouter streaming from Inspector" as out-of-scope | Convex `/stream` is now the primary hosted chat path, not a fallback |
| §5 #6 | Removed "parameterized with a direct OpenRouter stream source" | No new stream provider needed; reuse existing Convex `/stream` hop |
| §5 #7 | Clarified Inspector never holds or needs OpenRouter keys | Keys exist only in Convex server env |
| §6 Chat mode | Removed `OpenRouterStreamProvider` and `UIMessageChunk` adapter | Not needed — `handleMCPJamFreeChatModel` works as-is |
| §7 Chat note | Changed "does not require Convex `/stream`" to "uses Convex `/stream`" | Convex `/stream` is the LLM path in V1 |
| §10 #8 | Moved `WEB_OPENROUTER_API_KEY` from required to not-required | Inspector never calls OpenRouter directly |
| §10 Optional | Removed `WEB_OPENROUTER_BASE_URL` | Same reason |
| §11 Unit #4 | Changed from `WEB_OPENROUTER_API_KEY` check to `CONVEX_HTTP_URL` check | That's the actual dependency now |
| §11 Unit #9 | Removed `UIMessageChunk` adapter test | Adapter doesn't exist |
| §11 Removed #6-7 | Added removed test entries with rationale | Traceability |
| §12 #6 | Simplified from "parameterize with OpenRouterStreamProvider" to "wire to handleMCPJamFreeChatModel with hosted auth" | No adapter to build |

### Implementation readiness review (2026-02-16)

Codebase audit of both inspector and backend confirmed plan alignment and resolved remaining ambiguities.

| Section | What changed | Why |
|---------|-------------|-----|
| §5 #11 | Added baseline error code catalog (UNAUTHORIZED, FORBIDDEN, NOT_FOUND, VALIDATION_ERROR, RATE_LIMITED, FEATURE_NOT_SUPPORTED, SERVER_UNREACHABLE, TIMEOUT, INTERNAL_ERROR) | Error shape was locked but codes were undefined — would cause inconsistency across routes during implementation |
| §5 #13 | Added new locked decision: request-scoped MCP execution uses ephemeral `MCPClientManager` instances | Existing `MCPClientManager` already supports this pattern natively (constructor accepts configs, `ensureConnected()` awaits in-flight promises, `disconnectAllServers()` handles teardown). No new class needed. Design confirmed by code audit of `sdk/src/mcp-client-manager/MCPClientManager.ts` |
| §6 #2 | Added note locking `selectedServerIds` as hosted field name, distinct from local-mode `selectedServers` | Naming inconsistency between doc and existing `ChatV2Request` type would cause confusion during implementation |
| §6 Chat #3 | Replaced abstract lifecycle description with concrete ephemeral manager pattern | Documents the actual constructor → `ensureConnected()` → `disconnectAllServers()` flow |
| §7 CORS note | Added note that Convex `corsHeaders()` must add production hosted origin | Backend CORS allowlist is currently localhost-only; `/web/authorize` would reject browser requests from the hosted frontend without this |
| §9 #4 | Added `hono/body-limit` as the enforcement mechanism for 1MB body limit | Hono doesn't enforce body limits by default; implementation needed a specified approach |
| §9 #5 | Cross-referenced error codes in §5 #11 | Connects security requirement to the locked code catalog |
| §10 #3 | Added `CONVEX_HTTP_URL` to required env vars | Was already used for `/stream` calls and referenced in §11 Unit #4, but missing from the env contract |
| §12 | Fixed phase numbering (was 1-5, 7-9; now 1-8) | Phase 6 was missing |
| §12 #1 | Added "(ephemeral `MCPClientManager` per request)" | Ties vertical slice to the locked connection pattern |
| §12 #3 | Added "Convex CORS allowlist update" to phase | Backend deployment prerequisite that was undocumented |
| §12 #8 | Added "`hono/body-limit`" to hardening phase | Specifies the body-size enforcement tool |

### Security review (2026-02-16)

External review identified 3 high-severity gaps and 4 medium-severity alignment issues. All addressed below.

| Section | What changed | Why |
|---------|-------------|-----|
| §5 #13 | **[High]** Corrected streaming teardown: route-level `finally` replaced with `onFinish` callback in `createUIMessageStream` | `handleMCPJamFreeChatModel` returns a `Response` immediately (line 730). Route-level `finally` fires before the stream completes, killing connections mid-stream. `onFinish` fires on stream completion or client abort — the only safe teardown point |
| §6 Chat #3 | Updated lifecycle to reference `onFinish` instead of route-level `finally` | Consistency with §5 #13 fix |
| §9 #1 | **[High]** Added `/api/apps/*` to hosted strict mode block list | Legacy `/api/apps/mcp-apps/*` and `/api/apps/chatgpt-apps/*` routes are explicitly unprotected by session auth (sandboxed iframe design). In multi-tenant hosted mode, this exposes cross-user widget data (`widget/store`, `widget-content`), file uploads, and MCP resource access without any auth |
| §7 CORS note | **[High]** Strengthened CORS fix: Convex `corsHeaders()` must not fall back to `*` for non-allowlisted origins | Current code (line 17): `origin in allowlist ? origin : '*'` — directly violates exact-origin CORS requirement. Must omit CORS header or return 403 for non-allowlisted origins |
| §6 #8-9 | **[Medium]** Added `POST /api/web/prompts/list-multi` and `POST /api/web/prompts/get` | UI prompts popover requires `list-multi` (batch list for selected servers) and `get` (fetch prompt content with arguments). Plan only had `prompts/list` |
| §6 #11-13 | **[Medium]** ~~Expanded ChatGPT Apps to 3-step flow~~ **(superseded — see "Hosted ChatGPT Apps renderer redesign" below)** | Originally identified 3-step flow as needed; resolved instead by adopting MCP Apps pattern (single authenticated POST + `SandboxedIframe`), which is both simpler and eliminates the iframe auth blocker |
| §7 `/web/authorize` | **[Medium]** Added explicit rejection of `transportType=stdio` and `useOAuth=true` servers | Hosted V1 cannot spawn subprocesses (§4.3) or handle OAuth flows (§4.4). Without this guard, `/web/authorize` would return configs that the inspector cannot connect to |
| §11 Integration #3 | Added `/api/apps/*` blocked test | Covers new strict mode block |
| §11 Integration #13-16 | Added `/web/authorize` server type rejection tests and `onFinish` cleanup tests | Covers new authorize guards and streaming teardown |
| Changelog §6 Chat | Fixed stale reference to `OpenRouterStreamProvider` adapter | Changelog text still mentioned adapter path that was removed in freemcpjam scope cut |

### Hosted ChatGPT Apps renderer redesign (2026-02-16)

The iframe auth blocker (browsers cannot set `Authorization` headers on iframe `src` navigation) was resolved by adopting the MCP Apps rendering pattern for hosted ChatGPT Apps. Instead of the local-mode 3-step flow that requires unauthenticated GET endpoints, the hosted renderer uses a single authenticated POST + `SandboxedIframe` injection. This eliminates the need for server-side widget state, unauthenticated endpoints, and the iframe auth workaround entirely.

| Section | What changed | Why |
|---------|-------------|-----|
| §6 header | Removed "unless noted" caveat — all hosted routes now require bearer JWT with no exceptions | MCP Apps pattern eliminates the only candidate for unauthenticated routes |
| §6 #11 | Replaced 3-step ChatGPT Apps flow (`widget/store` → `widget-html/:toolId` → `widget-content/:toolId`) with single `POST /api/web/apps/chatgpt-apps/widget-content` | Local-mode 3-step flow requires unauthenticated GET for iframe `src`. Hosted renderer uses authenticated POST + `SandboxedIframe` `postMessage`/`srcdoc` injection (same pattern as MCP Apps). Scope reduction: 3 endpoints → 1, no server-side widget store needed |
| §8 | Added "Hosted ChatGPT Apps renderer" subsection | New component in `client/src/components/hosted/` that reuses `SandboxedIframe`. Local-mode `chatgpt-app-renderer.tsx` is unchanged. The hosted renderer is a separate, simpler component |

### Hosted OAuth support (2026-02-17)

OAuth-required MCP server connections are now in-scope for hosted mode. The inspector provides authenticated CORS proxy routes for OAuth flows (metadata discovery, client registration, token exchange) with HTTPS-only enforcement.

| Section | What changed | Why |
|---------|-------------|-----|
| §3 #9 | Added hosted OAuth proxy to in-scope | OAuth-required MCP servers are common; blocking them would limit hosted mode utility |
| §4 #4 | Struck through "OAuth-required MCP server connections" as out-of-scope | Moved to in-scope (§3 #9) |
| §5 #14 | Added locked decision: hosted OAuth CORS proxy with HTTPS-only enforcement | Documents proxy architecture, HTTPS-only security posture, code deduplication with local mode, and deferred URL scoping |
| §6 #1-9 | Added `oauthAccessToken?` field to all single-server route requests | OAuth-enabled servers require access token injection as `Authorization: Bearer` on MCP connections |
| §6 #2, #8 | Added `oauthTokens?: Record<string, string>` to multi-server routes (`chat-v2`, `prompts/list-multi`) | Maps server IDs to OAuth access tokens for multi-server operations |
| §6 #12-13 | Added `POST /api/web/oauth/proxy` and `GET /api/web/oauth/metadata` routes | Authenticated CORS proxy for OAuth token exchange, client registration, and metadata discovery |
| §7 `/web/authorize` | Removed `useOAuth === true → error` rejection; `serverConfig` now returns `useOAuth` flag | Inspector needs to know which servers require OAuth so it can enforce token requirements client-side |
| §9 #7 | Added HTTPS-only enforcement security requirement for hosted OAuth proxy | Prevents SSRF to internal HTTP services; MCP Auth spec mandates HTTPS for all auth server endpoints |
| §11 Integration #15 | Changed from "rejects `useOAuth=true`" to "returns `useOAuth` flag in `serverConfig`" | `/web/authorize` no longer rejects OAuth servers |
| §11 Integration #16-19 | Added OAuth-specific integration tests (HTTPS-only enforcement, proxy auth, OAuth server validation, chat with OAuth tokens) | Coverage for new OAuth proxy and execution paths |
| §14 #8 | Added OAuth server acceptance criterion | OAuth-enabled servers must be validatable and usable in hosted mode |