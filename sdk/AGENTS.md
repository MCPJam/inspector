# SDK (`sdk/`, published as `@mcpjam/sdk`)

The package other workspaces and users install: the MCP client manager, the
eval runtime, conformance suites, host config, the evaluation contract, the
platform API client and OAuth. Entry points are the `exports` map in
`package.json`. Inspector-only code belongs in `mcpjam-inspector/`.

## Imports

- The only workspace dependency is `@mcpjam/evaluators`. Importing the inspector
  or another workspace is not enforced; do not do it.
- No raw `@modelcontextprotocol/sdk` (v1); use the v2 `@modelcontextprotocol/*`
  packages. Enforced by `npm run check:mcp-v1-runtime-imports` (root; CI runs it
  in `test:checks`).
- `src/platform/` and `src/deployment/address.ts` run in browsers and Workers:
  no `node:` imports, no `process.env`. Enforced by
  `npm run check:platform-runtime-safety` (and `:dist` after a build).
- The browser, worker and contract entries reach no Node built-in through any
  import. Enforced by `tests/browser-no-node-imports.test.ts` and
  `tests/worker-no-node-imports.test.ts`: `npm run test -w @mcpjam/sdk`.

## Rules

- `app.mcpjam.com` appears only in `src/deployment/address.ts`. Enforced by
  `npm run check:cloud-default-literals`.
- Never hand-edit `src/**/*.generated.ts`; rerun the `scripts/generate-*.ts`
  that writes it. The eval-suite and verdict-policy schemas fail
  `npm run test -w @mcpjam/sdk` when stale. `check:host-catalog-fallback` runs
  only by hand.
- Exports named in `test:packaging:assert` must keep existing. Enforced by
  `npm run test:packaging -w @mcpjam/sdk`.
- No new `as any`, `@ts-*` suppressions, `eslint-disable` or empty catches.
  Enforced by `npm run slop:check`.
- Check lint with `npm run lint -w @mcpjam/sdk` (typescript-eslint, Prettier).

## Verify

`npm run typecheck -w @mcpjam/sdk`, `npm run test -w @mcpjam/sdk`,
`npm run test:packaging -w @mcpjam/sdk` when exports change, and
`npm run slop:check`.
