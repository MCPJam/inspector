# Fix a bug in MCPJam

Macro: `!mcpjam-bug`

## Overview

Take a bug report (GitHub issue, Sentry event, Slack thread or a description),
reproduce it, fix the cause, and open one focused PR against `MCPJam/inspector`.

## What's Needed From User

- The bug report: link or text, and the expected behavior.
- Whether the bug needs a signed-in account to reproduce. Devin can only use
  guest mode.

## Procedure

1. Read the report and restate the bug in one sentence: what happens, what
   should happen, and where.
2. Find the code path. Search for the error text, the route or the component
   name before reading broadly.
3. Reproduce the bug.
   - Logic bug: write a failing test in the `__tests__/` directory next to the
     source.
   - Visible bug: run the app with the `run-inspector` skill and screenshot it.
4. Fix the cause, not the symptom. Keep the diff to what the fix needs.
5. Make the failing test pass, and run the checks from the `verify-before-pr`
   skill for the files you changed.
6. Add a changeset if the fix is user-visible in a releasable package.
7. Open a PR titled in Conventional Commits form (`fix(client): ...`). The
   description says what was wrong, why, and how you verified the fix, with
   screenshots for anything visible.
8. Watch CI. On a red check, use the `fix-ci` skill.

## Specifications

- A test that fails before the fix and passes after it, unless the bug is
  purely visual.
- One PR, one bug. No drive-by refactors.
- All CI checks green, or each remaining failure explained in the PR as
  pre-existing or unrelated.

## Advice and Pointers

- Server errors: check whether the failure is the user's MCP server or MCPJam.
  Proxy failures should not page Sentry; see the `server-change` skill.
- The repo has `AGENTS.md` files at the root and in `mcpjam-inspector/`. Follow them.
- If the report is ambiguous, write down your interpretation in the PR and
  proceed rather than stopping.

## Forbidden Actions

- Do not skip, delete or weaken an existing test to make CI pass.
- Do not edit generated files: DESIGN.md front matter, the token blocks in
  `docs/style.css` and `chat-ui/src/styles.css`, or `browserd/dist/` by hand.
- Do not add `console.*` to server code.
- Do not push to `main` or merge your own PR.
