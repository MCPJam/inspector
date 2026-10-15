# Make a UI change in MCPJam

Macro: `!mcpjam-ui`

## Overview

Implement a UI or copy change in the MCPJam Inspector and prove it with
light and dark screenshots.

## What's Needed From User

- The change: what the screen should do or say afterward. A screenshot or
  Figma link if one exists.
- Which screen, or the route to reach it.

## Procedure

1. Read `DESIGN.md` and the `ui-change` skill.
2. Run the app with the `run-inspector` skill and screenshot the current state.
3. Find the component. Check `design-system/src/components/` for a primitive
   before building anything new.
4. Make the change with role tokens and design-system primitives.
5. Update or add the component test in the nearest `__tests__/` directory.
6. Run `npm run typecheck:client -w @mcpjam/inspector` and the matching tests.
7. Screenshot the result in light and dark mode, at desktop width and at a
   narrow width if the screen is used on small windows.
8. Open a PR with before and after screenshots in the description.
9. Watch CI. On a red check, use the `fix-ci` skill.

## Specifications

- No literal color values. Only role tokens.
- Readable in both themes.
- Before and after screenshots in the PR.
- Copy is short, concrete, and has no em dashes.

## Advice and Pointers

- Extend a primitive with a cva variant instead of restyling it at the call site.
- Text on solid `primary`, `destructive`, `success`, `info` or `pending` fills
  fails contrast at small sizes; use a tint.
- Copy-only changes still need a screenshot, because truncation and wrapping
  break layouts.

## Forbidden Actions

- Do not add a hex, `rgb()` or `oklch()` value to a component or stylesheet.
- Do not hand-edit DESIGN.md's front matter or other generated token regions.
- Do not change unrelated screens.
