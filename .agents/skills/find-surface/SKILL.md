---
name: find-surface
description: Turn a loose description of part of the inspector UI ("the skills thing in the left sidebar", "where I run evals") into the exact screen, its files and its tests. Use when a request names a part of the UI in the user's own words instead of a file or route.
---

# Find a surface

The feature map lists every inspector screen with the label the UI shows, its
place in the sidebar or Connect tabs, its route, the component that renders it
and the tests that exercise it. It is read from source on every run.

## Find it

From the repo root:

```bash
npm run feature-map -w @mcpjam/inspector -- find <the user's words>
```

- Pass the user's phrase as written. Add `--json` to read the result in code.
- Each result prints its id, UI label, place, route, rendering component and
  the words that matched.
- Exit code 1 means no confident match: no id, label, alias or route word
  matched exactly, a query word matched no surface, or another surface scored
  close to the best one (listed as `ambiguous` in `--json`). The closest
  candidates are still printed; treat them as guesses.

## Confirm it

Name the top result back to the user in the UI's own words before you change
anything: "The Skills tab in the Connect view, at `/p/:projectId/skills`?"
Ask when the run exited 1.

## Start from it

```bash
npm run feature-map -w @mcpjam/inspector -- show <id>
```

- `renders` is where the screen starts. `children` are the feature components
  it imports one level down.
- `e2e` and `component tests` are the tests to run and extend for a change to
  that screen.
- `list` prints every surface.

## Limits

- Dialogs, drawers, account-menu items and sub-tabs inside a screen are not
  surfaces. Find the screen that holds them, then search its children.
- Labels come from the sidebar, the Connect view tabs and the manifest title
  in `shared/app-surfaces.ts`, not from headings inside a screen.
- Words people use that the code does not belong in
  `mcpjam-inspector/scripts/feature-map-aliases.json`, keyed by surface id.
