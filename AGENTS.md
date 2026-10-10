# AGENTS.md

Repository-wide instructions for AI coding agents. Package-specific rules live
alongside their code — see `mcpjam-inspector/AGENTS.md` for the inspector app.

## Pull requests

`gh pr create --body` skips GitHub's PR template. When you write a PR body,
read `.github/pull_request_template.md` and fill in every section. Where a
section does not apply, use the exact text that section's comment gives
("Nothing", "Nothing applicable", or "None: …").

## Code quality contract

These rules bind every change, human or agent. Agents write most of the code
here, so the cheap place to stop slop is before the PR exists. CI and the
hooks in `.claude/settings.json` check the same rules (`scripts/slop/`).

### Before you finish

Run these and fix what they report before you end the turn or open a PR:

```
npm run slop:check                      # no rule may go up (scripts/slop/rules.mjs)
npm run typecheck -w <package you touched>
npm test -w <package you touched>
```

Script names differ in a few workspaces:

| Workspace                                                          | Typecheck                              | Tests       |
| ------------------------------------------------------------------ | -------------------------------------- | ----------- |
| `@mcpjam/inspector`                                                | `typecheck:client`, `typecheck:server` | `test`      |
| `@mcpjam/slack-app`, `@mcpjam/discord-app`, `@mcpjam/surface-core` | `verify` (check, lint and test)        | `verify`    |
| `@mcpjam/soundcheck`                                               | `typecheck`                            | `test:auth` |

Then write the PR body as described under Pull requests above. In your last
message, list what you deleted and what existing code you reused.

### Size

- A new file stays under 400 lines; a function under 80.
- A file already over 800 lines does not grow. Put new code in its own module.
- A PR stays under 400 changed lines of hand-written source. Larger needs the
  `large-pr` label; over 1,500 needs to be split or labelled `mechanical`.
- A move or split is its own PR with no behavior change in it.

### Reuse before you write

Search before adding a helper. `isRecord`, `sleep`, `truncate`,
`formatDuration`, `stableStringify` and retry loops already exist many times
over; adding another copy makes the next cleanup harder. Shared code lives in:

- `sdk/` for anything the CLI, the inspector server or a user can import.
- `mcpjam-inspector/shared/` for code both the inspector client and server
  use, such as `abort-errors.ts`.
- `design-system/` for tokens and primitives, `chat-ui/` for chat components.
  The inspector imports `chat-ui` rather than copying from it.

### One way to do a thing

When you add a v2, delete the v1 in the same PR. If you cannot, say in the PR
who removes it and by when. Do not leave a deprecated alias with live callers.

### Errors

- Handle or report an error; never swallow it. A best-effort catch carries a
  comment saying why the failure is safe to ignore, and a debug-level log.
- No `.catch(() => {})` and no empty `catch {}`.
- Server code logs through `logger`, never `console` (see
  `mcpjam-inspector/AGENTS.md`).

### Types

- No `as any`, `: any` or `as unknown as`. Fix the type, narrow with a guard,
  or parse with zod at the boundary.
- No new `@ts-ignore`, `@ts-expect-error`, `@ts-nocheck` or `eslint-disable`.
  A suppression that must stay names the rule and the reason on the same line.

### Comments

A comment says why the code is this way now. How it got here belongs in the
commit message and PR description. Do not cite PR numbers, issue or ticket
IDs, dates, phases or "used to" in source comments.

### Repo hygiene

No scratch files in the repo: no `NOTES-*.md`, no `.spike-*` folders, no new
root files. Keep working notes in your scratch directory and put the
conclusions in the PR description.

## Design

**Read [`DESIGN.md`](./DESIGN.md) before any UI or styling work.** It describes the
MCPJam design system — color roles, typography, layout, elevation, shapes, and the
component primitives — in the open DESIGN.md format, so it is equally readable by
agents working outside this repository.

- `design-system/src/tokens.css` is the single source of truth for the palette.
- `DESIGN.md`'s YAML front matter is **generated** from it. So are the fenced blocks
  in `docs/style.css` and `chat-ui/src/styles.css`, and the derived color fields in
  `docs/docs.json`. Never hand-edit a generated region.
- Change a color by editing `tokens.css`, then run `npm run design:sync`.
- `npm run design:check` (drift) and `npm run design:lint` (spec) both gate CI.
- Never write a literal hex or `oklch()` value into a component or a stylesheet
  — use the role tokens. Role values live in `design-system/src/tokens.css` and
  nowhere else.
- The one exception is a package-local accent palette deliberately outside the
  role system (chat-ui's `--trace-waterfall-*`). Adding another is a real
  decision, not a shortcut around the rule: it will not track the theme, and
  nothing will check it.

## The browserd daemon bundle

`mcpjam-inspector/server/services/browserd/dist/` is CHECKED IN: the daemon runs
on a sandbox that has only those bytes and no build step, so a daemon edit that
is not re-bundled ships the previous daemon.

After touching anything under `server/services/browserd/daemon/` — or anything
it imports, which now includes `protocol.ts` and the WebMCP launch flags — run:

```
npm run bundle:browserd -w @mcpjam/inspector
```

and commit both files in `dist/`. `pretest` runs
`node scripts/bundle-browserd.mjs --check`, which rebuilds in memory, writes
nothing, and fails with the remediation if the checked-in bundle is stale;
`server/services/browserd/__tests__/bundle-freshness.test.ts` asserts the same
property from inside the suite.
