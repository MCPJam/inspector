---
name: server-change
description: Rules for changes to the inspector's Hono server (mcpjam-inspector/server), including routes, services, logging, error reporting and the browserd daemon. Use before editing anything under mcpjam-inspector/server.
---

# Server change

## Logging and errors

Never use `console.*` in `server/`.

```ts
import { logger } from "@/utils/logger";
```

- `logger.error` goes to Sentry and Axiom. Use it only for real failures in
  MCPJam's own code.
- `logger.warn`, `logger.info` and `logger.debug` go to Axiom only.
- Route catch sites call `reportRouteFailure` from
  `server/utils/route-error-report.ts`, not `logger.error`. Pass the hop that
  failed, so a user's broken MCP server does not page MCPJam:
  ```ts
  reportRouteFailure("[mcp/chat-v2] stream error", error, {
    source: "mcp.chat-v2.stream",
    hop: "user_server_hop", // or "mcpjam_internal"
  });
  ```
  Anything under `/api/mcp/*` that proxies to a user's server is
  `user_server_hop`.
- Never log tokens, access links, API keys or request bodies that may hold them.

Background: `mcpjam-inspector/docs/server-error-reporting.md`.

## Tests

- Route tests: `server/routes/mcp/__tests__/`. Helpers in
  `server/routes/mcp/__tests__/helpers/` (`createTestApp()`,
  `createMockMcpClientManager()`, `postJson()`, `expectError()`).
- Anything whose correctness depends on WorkOS behavior (refresh tokens, API key
  revocation, JWKS) uses the emulator suites (`*.emulator.test.ts`) and
  `server/test/support/workos-emulator.ts`. Do not stub `fetch` for those.
  Do not export `WORKOS_API_BASE_URL` in the shell.
- Cover the happy path, validation errors, error handling and empty/null input.

```bash
npm run test -w @mcpjam/inspector -- server/routes/<area>
```

## browserd daemon

`server/services/browserd/dist/` is checked in and is what ships. After
changing anything under `server/services/browserd/daemon/`, or anything it
imports (`protocol.ts`, the WebMCP launch flags):

```bash
npm run bundle:browserd -w @mcpjam/inspector
```

Commit both files in `dist/`. `pretest` fails if the bundle is stale.

## Auth-sensitive areas

Changes to `server/routes/workos-authkit.ts`, `server/services/authkit-jwt.ts`,
`server/services/guest-token*.ts`, `server/services/api-keys-relay.ts` or
`server/middleware/` need a PR description that states who can reach the code
path before and after the change.
