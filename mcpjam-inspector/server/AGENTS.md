# Inspector server (`mcpjam-inspector/server/`)

The Hono server: `routes/` (`web/` hosted API, `mcp/` local API, `v1/` public
API, `apps/`), `middleware/`, `services/` and `utils/`. Code the client also
needs goes in `../shared/`. Logging and error-reporting policy is in
`../AGENTS.md` and `utils/LOGGING.md`.

## Imports

Allowed: `@/shared/*`, and `@mcpjam/sdk` or its subpaths by package name.

- No relative import of `client/` or of `sdk/src/`. Enforced by
  `layers/no-cross-layer-imports` in `eslint.config.js`:
  `npm run lint -w @mcpjam/inspector`.
  Tests are exempt.
- No raw `@modelcontextprotocol/sdk`; use `@mcpjam/sdk`. Enforced by
  `npm run check:mcp-v1-runtime-imports` (root; CI runs it in `test:checks`).

## Rules

- In a `catch` under `routes/` (outside `routes/web/`), report with
  `reportRouteFailure` (`utils/route-error-report.ts`), not `logger.error`.
  Enforced by `no-restricted-syntax`: `npm run lint -w @mcpjam/inspector`.
- In `routes/web/`, `logger.warn/error/info` fail lint. Report a caught
  failure with `reportRouteFailure`; emit anything else as a typed
  `logger.event()` from the `utils/LOGGING.md` catalog. Same lint command.
- No raw `console.*`; use `logger` from `@/utils/logger`. Enforced by the
  `server-console` slop rule: `npm run slop:check`.
- Only `services/service-credential.ts` reads `INSPECTOR_SERVICE_TOKEN`.
  Enforced by `npm run check:service-credential-reads` (root, `test:checks`).
- Hosted code gets MCP clients from the guarded factory, never
  `new MCPClientManager`. Enforced by `npm run check:hosted-manager-base-fetch`.
- Assistant turns start through `runUnifiedAssistantTurn`
  (`utils/turn-execution.ts`). Enforced by `npm run check:turn-entry-point`.
- A file's type-error count may only go down. Enforced by
  `npm run typecheck:server -w @mcpjam/inspector` against `tsc-baseline.json`.

## Verify

`npm run typecheck:server -w @mcpjam/inspector`, `npm run lint -w @mcpjam/inspector`,
`npm run slop:check`, and `npm run test -w @mcpjam/inspector -- server/<path>`.
