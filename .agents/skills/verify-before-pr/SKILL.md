---
name: verify-before-pr
description: Run the checks CI will run on the files you changed in the MCPJam monorepo, before opening or updating a PR. Use after any code change and before every push.
---

# Verify before PR

CI runs typecheck, design checks, a production build, ten workspace suites
and six inspector shards. A full local `npm run verify` takes a long time, so
run what your diff touches and let CI cover the rest.

## 1. See what changed

```bash
git diff --name-only origin/main...HEAD
```

## 2. Run the matching checks

| Changed path                                                         | Run from repo root                                                                                       |
| -------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------- |
| `mcpjam-inspector/client/**`                                         | `npm run typecheck:client -w @mcpjam/inspector` and `npm run test -w @mcpjam/inspector -- client/<area>` |
| `mcpjam-inspector/server/**`                                         | `npm run test -w @mcpjam/inspector -- server/<area>`                                                     |
| `mcpjam-inspector/shared/**`                                         | `npm run test -w @mcpjam/inspector -- shared` plus the client typecheck                                  |
| `mcpjam-inspector/server/services/browserd/daemon/**`, `protocol.ts` | `npm run bundle:browserd -w @mcpjam/inspector`, then commit both files in `dist/`                        |
| `sdk/**`                                                             | `npm run test -w @mcpjam/sdk` and `npm run typecheck` (the CLI and inspector import the SDK)             |
| `cli/**`                                                             | `npm run test:fast -w @mcpjam/cli`                                                                       |
| `design-system/src/tokens.css`                                       | `npm run design:sync`, then `npm run design:check && npm run design:lint`                                |
| `design-system/**`, `chat-ui/**`, `widget-react/**`                  | `npm run test -w @mcpjam/<package>` and `npm run typecheck`                                              |
| `mcp/**`                                                             | `npm run test:fast -w @mcpjam/mcp && npm run typecheck:fast -w @mcpjam/mcp`                              |

Inspector tests use Vitest. Pass a path or name pattern after `--`; running
the whole inspector suite (~14k tests) is rarely worth it locally.

## 3. Format

The repo is not Prettier-clean. Running `prettier --write` on a whole file,
or the tree, produces large unrelated diffs. Format only the lines you
changed, and revert any formatting churn before committing:

```bash
git diff origin/main...HEAD --stat   # a file with far more changed lines than you wrote is churn
```

New files you created can be formatted in full.

## 4. Changeset

User-visible changes to a releasable package (`@mcpjam/inspector`, `sdk`,
`cli`, `evaluators`, `vitest`, `chat-ui`, `widget-react`) need a changeset.
Write `.changeset/<short-slug>.md`:

```md
---
"@mcpjam/inspector": patch
---

One sentence a user would understand.
```

Internal-only changes (tests, CI, refactors with no behavior change) do not.

## 5. Before pushing

- `npm run slop:check` passes: no rule in `scripts/slop/rules.mjs` may go up.
- Every behavior change has a test in a `__tests__/` directory next to the source.
- No `console.*` in `server/`; use `logger` (see `mcpjam-inspector/AGENTS.md`).
- No literal color values; use role tokens (see `DESIGN.md`).
- Commit messages follow Conventional Commits: `fix(client): ...`, `feat(server): ...`.
- UI change: attach a screenshot to the PR (see the `run-inspector` skill).
- The PR body fills in every section of `.github/pull_request_template.md`.

## When a check fails and you did not touch that area

Check whether it fails on `main` too (`git stash`, rerun, `git stash pop`).
If it does, say so in the PR description instead of fixing unrelated code.
