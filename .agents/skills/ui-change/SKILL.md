---
name: ui-change
description: Rules for any change to MCPJam's UI (inspector client, design-system, chat-ui, widget-react, docs styling). Use before editing a .tsx component, a stylesheet, or design tokens.
---

# UI change

Read `DESIGN.md` at the repo root first. It is the design system: color
roles, typography, layout, elevation, shapes and component conventions.

## Colors

- Use role tokens (`bg-card text-card-foreground`, `bg-destructive/10`), never
  a literal hex, `rgb()` or `oklch()` value. CI and review both reject them.
- Pair each surface with its `-foreground` role.
- Check the contrast table in DESIGN.md's Colors section before putting text on
  a solid fill. `primary`, `destructive`, `success`, `info` and `pending` fills
  are too low-contrast for small text; use a tint with the reading foreground.
- `success`, `warning`, `info` and `pending` are for state only.
- Need a new color? Add it to `design-system/src/tokens.css`, run
  `npm run design:sync`, then `npm run design:check && npm run design:lint`.
  Never edit DESIGN.md's front matter or the fenced token blocks in
  `docs/style.css` and `chat-ui/src/styles.css` by hand.

## Components

- Import primitives per file from the design system:
  ```tsx
  import { Button } from "@mcpjam/design-system/button";
  import { cn } from "@mcpjam/design-system/cn";
  ```
  The full list is `design-system/src/components/`.
- Extend a primitive through `className` or a new cva variant on the primitive.
  Do not restyle it ad hoc at the call site.
- Icons come from `lucide-react`, toasts from `sonner`.
- Prefer a border or tonal step over a shadow. No glass, glow or heavy elevation.

## Copy

- Short and concrete. No em dashes in UI copy.
- Say what happens, not what the feature is called internally.

## Tests

- Component tests live in `client/src/components/<area>/__tests__/`.
- Use the factories in `client/src/test/factories.ts` (`createServer()`,
  `createTool()`, `createMany()`) and the presets in `client/src/test/mocks/`.
- Run `npm run typecheck:client -w @mcpjam/inspector` and the matching tests.

## Show it

Run the app and attach light and dark screenshots to the PR. The
`run-inspector` skill has the steps.
