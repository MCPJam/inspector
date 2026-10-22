---
name: fix-ci
description: Diagnose and fix a failing GitHub Actions check on an MCPJam PR by mapping the failed job to the local command that reproduces it. Use when a PR check is red.
---

# Fix CI

## Map the job to a local command

| Workflow / job                             | Reproduce locally                                                                                     |
| ------------------------------------------ | ----------------------------------------------------------------------------------------------------- |
| Build and Test (`lint.yml`): design checks | `npm run design:check && npm run design:lint`                                                         |
| Build and Test: typecheck                  | `npm run typecheck` and `npm run typecheck:client -w @mcpjam/inspector`                               |
| Build and Test: build / production start   | `npm run build:inspector`, then `timeout 10s npm run start -w @mcpjam/inspector` (exit 124 = started) |
| Tests (`test.yml`): Run Tests              | `npm run test:ci:rest` (every suite except the inspector)                                             |
| Tests: inspector shard N/6                 | `npm run build -w @mcpjam/sdk && npm run test -w @mcpjam/inspector -- --shard=N/6`                    |
| Tests: packaging                           | `npm run test:ci:packaging`                                                                           |
| Tests: e2e                                 | `npm run build -w @mcpjam/inspector && npm run test:e2e -w @mcpjam/inspector`                         |
| Tests: authoring contracts                 | Compares against the backend repo; usually needs a backend change, so report it                       |
| `*-policy-drift.yml`                       | `npm run claude-policy:check` (or `openai-` / `muse-`); fix with the matching `:sync`                 |

## Steps

1. Read the failing job's log and find the first real error, not the last line.
2. Reproduce it locally with the command above. Narrow it: for a shard, run the
   single failing test file.
3. Decide whose failure it is:
   - Caused by this PR's diff: fix it.
   - Fails on `main` too: do not fix unrelated code. Note it in the PR and move on.
   - Flaky (passes on rerun locally, timing-based): note the test name in the PR.
   - Needs secrets the PR cannot have (preview deploys, Cloudflare, Railway): ignore.
4. Common causes in this repo:
   - Stale browserd bundle: `npm run bundle:browserd -w @mcpjam/inspector`.
   - Token drift after a `tokens.css` edit: `npm run design:sync`.
   - Missing `ripgrep`: the repo-guard checks in `npm test` need `rg`.
   - Out of memory in Vitest: `NODE_OPTIONS=--max-old-space-size=6144`.
5. Push the fix and wait for the rerun. Do not mark a test `.skip` to get green.
