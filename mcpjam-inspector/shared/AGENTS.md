# Inspector shared code (`mcpjam-inspector/shared/`)

Code that both the client bundle (browser) and the server (Node) load: wire
types, zod schemas, and pure helpers for chat, evals, the browser pane,
harnesses and log scrubbing. Code only one side uses belongs in `../client/` or
`../server/`. Code other packages need belongs in `sdk/`.

## Imports

Allowed: other `shared/` modules (relative or `@/shared/*`), `@mcpjam/sdk` or
its subpaths by package name, and packages that run in both browser and Node.

- No relative import of `server/`, `client/` or `sdk/src/`. Enforced by
  `layers/no-cross-layer-imports` in `eslint.config.js`:
  `npm run lint -w @mcpjam/inspector`.
  Tests are exempt.
- No `node:` built-ins. Same lint rule. Bare specifiers (`fs`, `path`) are not
  caught: not enforced.
- Existing violations in `sentry-build-metadata.ts` and
  `strict-server-analytics.ts` are suppressed in `eslint-suppressions.json`;
  do not add entries.
- Prefer `@mcpjam/sdk` over raw `@modelcontextprotocol/sdk`. Not enforced here:
  `check:mcp-v1-runtime-imports` does not scan `shared/`.

## Rules

- Only `server/services/service-credential.ts` reads `INSPECTOR_SERVICE_TOKEN`;
  this scan covers `shared/`. Enforced by `npm run check:service-credential-reads`.
- No new `as any`, `@ts-*` suppressions, `eslint-disable` or empty catches.
  Enforced by `npm run slop:check`.

## Verify

`shared/` compiles in both programs. `npm run typecheck:client -w @mcpjam/inspector`
fails on any error in it. `npm run typecheck:server -w @mcpjam/inspector` is a
ratchet over `server/` files: it fails only when a file's error count rises
above its baseline, so a change that swaps one server error for another
passes. `npx tsc --noEmit -p server/tsconfig.json` shows the diagnostics.
Then `npm run lint -w @mcpjam/inspector`, `npm run slop:check`, and
`npm run test -w @mcpjam/inspector -- shared/<path>`.
