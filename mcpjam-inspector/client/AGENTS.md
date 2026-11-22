# Inspector client (`mcpjam-inspector/client/`)

The React + Vite app: `src/components/`, `src/hooks/`, `src/stores/`,
`src/state/`, `src/contexts/`, `src/lib/` and the router. Code the server also
needs goes in `../shared/`. Primitives go in `design-system/`, chat components
in `chat-ui/`, and the widget renderer in `widget-react/`.

## Imports

Allowed: `@/shared/*`, `@mcpjam/design-system/*`, `@mcpjam/chat-ui`,
`@mcpjam/widget-react`, and `@mcpjam/sdk` or its subpaths by package name.

- No relative import of `server/` or of `sdk/src/`. Enforced by
  `layers/no-cross-layer-imports` in `eslint.config.js`:
  `npm run lint -w @mcpjam/inspector`.
  Tests (`__tests__/`, `*.test.ts(x)`) are exempt.
- No raw `@modelcontextprotocol/sdk`; use `@mcpjam/sdk`. Enforced by
  `npm run check:mcp-v1-runtime-imports` (root; CI runs it in `test:checks`).
- Widget glue reaches app state only through the widget host
  (`check:renderer-tier-b`); browser-pane code takes no product or deployment
  globals (`check:browser-viewer`); pop-ups follow `../AGENTS.md`
  (`check:announcement-popups`). `npm run typecheck:client -w @mcpjam/inspector`
  runs all three first.

## Rules

- Hooks follow `react-hooks/rules-of-hooks` and `exhaustive-deps`. Enforced by
  `npm run lint -w @mcpjam/inspector`. Do not add `eslint-suppressions.json`
  entries; after fixing old ones, run `npm run lint:prune -w @mcpjam/inspector`.
- No new `useEffect`, `useLayoutEffect` or timers. No check enforces this yet;
  reviewers block it.
- Colors come from role tokens (DESIGN.md), not hex/`rgb()`/`oklch()` literals
  or Tailwind palette classes. No check enforces this yet; REVIEW.md blocks it.
- No em/en dashes, filler or vague error openers in user-facing copy, and no new
  `as any`, `@ts-*`, `eslint-disable` or empty catches. Enforced by the slop
  ratchet: `npm run slop:check`.

## Verify

`npm run typecheck:client -w @mcpjam/inspector` (root `npm run typecheck` skips
the client), `npm run lint -w @mcpjam/inspector`, `npm run slop:check`, and
`npm run test -w @mcpjam/inspector -- client/src/<path>`.
