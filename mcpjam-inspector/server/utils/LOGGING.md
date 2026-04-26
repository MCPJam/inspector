# Server Logging Conventions

## Quick rule

- **New production diagnostics in `server/routes/`** → use `logger.event()` via `getRequestLogger`
- **Ad-hoc debugging anywhere** → `logger.debug()` is fine
- **Legacy code outside converted routes** → `logger.warn/error` remain; migrate opportunistically
- **Roadmap and sequencing** → keep out of `//` comments. Do not reference other PRs in code (e.g. “PR6 will replace this”); use the current PR description, a tracking issue, or a short update here if the team needs a written reminder.

---

## Why typed events?

`logger.warn("something failed", { ... })` produces unstructured Axiom rows that are hard to query.
`logger.event("tunnel.created", ...)` produces a row you can filter by `event`, `workspaceId`, `orgId`, `route`, etc. without grepping prose.

---

## How to emit a typed event from a route handler

```ts
import { getRequestLogger } from "../../utils/request-logger.js";
import { classifyError } from "../../utils/error-classify.js";

// inside a Hono handler that has `c: Context`
getRequestLogger(c, "routes.web.tools").event("mcp.tool.execution.failed", {
  toolName: body.toolName,
  serverId: body.serverId,
  errorCode: classifyError(error),
});
```

The request context (`workspaceId`, `orgId`, `workspaceRole`, etc.) is automatically
picked up from `c.var.requestLogContext`, which is populated by:
1. `requestLogContextMiddleware` at request start (sets `requestId`, `route`, `method`)
2. `authorizeServer` / `createAuthorizedManager` after Convex auth succeeds (sets workspace + user fields)

---

## Event catalog

| Event | Emitted from | Key payload fields |
|---|---|---|
| `http.request.completed` | middleware | `statusCode` |
| `http.request.failed` | middleware | `statusCode`, `errorCode` |
| `mcp.oauth.proxy.failed` | `routes/mcp/oauth.ts`, `routes/web/oauth.ts` | `targetUrlHost`, `oauthPhase`, `errorCode`, `statusCode?` |
| `mcp.tool.execution.failed` | `routes/web/tools.ts` | `toolName`, `serverId?`, `errorCode` |
| `tunnel.created` | `routes/mcp/tunnels.ts` | `tunnelKind`, `tunnelDomain`, `existed`, `credentialIdPresent?` |
| `tunnel.creation_failed` | `routes/mcp/tunnels.ts` | `tunnelKind`, `errorCode` |
| `tunnel.record_failed` | `routes/mcp/tunnels.ts` | `tunnelKind`, `tunnelDomain?`, `errorCode` |
| `chat.session.persist.failed` | `utils/chat-ingestion.ts` | `failureKind`, `statusCode?`, `sourceType?` |
| `widget.resource.served` | `routes/apps/mcp-apps/index.ts` | `widgetType`, `resourceUri`, `cspMode`, `mimeTypeValid?` |
| `widget.resource.failed` | `routes/apps/mcp-apps/index.ts` | `widgetType`, `resourceUri?`, `errorCode` |
| `mcp.connection.closed_with_pending_requests` | `index.ts` (system event) | `errorCode` |

All events live in `server/utils/log-events.ts`. Add new events there before emitting them.

---

## Adding a new event

1. Add the event name and payload type to `RequestEventMap` (or `SystemEventMap`) in `log-events.ts`.
2. Emit it with `getRequestLogger(c, "routes.your.component").event("your.event.name", payload)`.
3. Add a row to the catalog table above.

---

## Scrubbing

All payloads are scrubbed by `scrubLogPayload` before reaching Axiom. Forbidden key substrings
(token, secret, email, authorization, cookie, apikey, stripe\*, pkce\*) are replaced with `"[redacted]"`.
String values are scanned for Bearer tokens, JWTs, email addresses, and `sk-` keys.

Never put raw error messages containing user input directly into event payloads without first
verifying they don't carry secrets.

---

## ESLint enforcement

`eslint.config.js` warns on new `logger.warn|error|info` calls in `server/routes/web/`.
Run `npx eslint server/routes/web/` to check before committing route changes.
