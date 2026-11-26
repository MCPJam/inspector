# Make a UI change in MCPJam

Macro: `!mcpjam-ui`

## Overview

Implement a UI or copy change in the MCPJam Inspector and prove it with
evidence from the PR's head commit, in light and dark. The evidence rules are
in [`.github/agent-pr-definition-of-done.md`](../../.github/agent-pr-definition-of-done.md).

## What's Needed From User

- The change: what the screen should do or say afterward. A screenshot or
  Figma link if one exists.
- Which screen, or the route to reach it.

## Procedure

1. Read `DESIGN.md`, the `ui-change` skill and
   `.github/agent-pr-definition-of-done.md`.
2. Run the app with the `run-inspector` skill and capture the current state of
   the screen in light and dark.
3. Find the component. Check `design-system/src/components/` for a primitive
   before building anything new.
4. Make the change with role tokens and design-system primitives.
5. Update or add the component test in the nearest `__tests__/` directory.
6. Run `npm run typecheck:client -w @mcpjam/inspector` and the matching tests.
7. Commit, then capture the same screen and state on that commit in light and
   dark, at desktop width and at a narrow width if the screen is used on small
   windows. Record the flow, under 60 seconds, for any interaction, loading or
   error state.
8. Open a PR. Attach the images and recordings on GitHub, in the PR
   description or a PR comment, and name the commit SHA they were taken on.
9. Watch CI. On a red check, use the `fix-ci` skill.
10. After any later commit that changes what the screen shows, recapture and
    replace the evidence, and update the SHA.

## Specifications

- No literal color values. Only role tokens.
- Readable in both themes.
- Before and after of the same screen and state, in light and dark, taken on
  the PR's head commit with that commit named next to them.
- A recording under 60 seconds for any interaction, loading or error state.
- Images and recordings hosted on GitHub. Devin-hosted links
  (`app.devin.ai/...`) and local paths (`/home/ubuntu/...`) don't count.
- Evidence from the real flow in the running app or the PR preview. Use mocks,
  Storybook or fixtures only when the real flow can't run, say why, and label
  each such capture as a fallback.
- Copy is short, concrete, and has no em dashes.
- Any acceptance criterion you couldn't check is marked "unverified" with the
  reason, and its box stays unticked.

## Advice and Pointers

- Extend a primitive with a cva variant instead of restyling it at the call site.
- Text on solid `primary`, `destructive`, `success`, `info` or `pending` fills
  fails contrast at small sizes; use a tint.
- Copy-only changes still need a screenshot, because truncation and wrapping
  break layouts.
- Signed-in screens follow the signed-in QA steps in `AGENTS.md`. If you can't
  reach one, capture it on the PR preview or mark it unverified.

## Forbidden Actions

- Do not add a hex, `rgb()` or `oklch()` value to a component or stylesheet.
- Do not hand-edit DESIGN.md's front matter or other generated token regions.
- Do not change unrelated screens.
- Do not write "None: no UI change" when the diff changes what a user sees.
- Do not tick the checklist box "I can explain every line of this diff without
  the agent that wrote it". That box is the human's.
