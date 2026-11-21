---
name: garden
description: Shrink one of the repo's ratchet baselines by fixing the code it excuses. Use when asked to garden, pay down lint or type debt, or lower a baseline, or when you have spare time in an area that a baseline lists.
---

# Garden a baseline

A ratchet lets existing violations stand and fails on new ones. Each one
below has a file that records what is excused. Gardening fixes some of that
code and lowers the record to match, so the excuse cannot be reused.

## The ratchets

| Ratchet | Record | Check | Lower it with |
| --- | --- | --- | --- |
| ESLint (hooks deps, layer imports, route catches) | `mcpjam-inspector/eslint-suppressions.json` | `npm run lint -w @mcpjam/inspector` | `npm run lint:prune -w @mcpjam/inspector` |
| Server type errors per file | `mcpjam-inspector/server/tsc-baseline.json` | `npm run typecheck:server -w @mcpjam/inspector` | `npm run typecheck:server -w @mcpjam/inspector -- --update` |
| Em dashes in client copy | `LEGACY_EM_DASH_COPY` in `mcpjam-inspector/client/src/lib/__tests__/em-dash-ratchet.test.ts` | `npm run test -w @mcpjam/inspector -- client/src/lib/__tests__/em-dash-ratchet.test.ts` | Edit the map by hand: lower the count, or delete the entry at zero |
| Slop rules (`scripts/slop/rules.mjs`) | None: compares the change with its merge base | `npm run slop:check` | Nothing to edit. `npm run slop:measure` shows the counts per package |

`analytics-ratchet.test.ts`, `oauth-redaction-ratchet.test.ts`,
`feature-flag-allowlist-ratchet.test.ts` and the two
`upload-route-ratchet.test.ts` files hold allowlists of legitimate homes, not
debt. Leave them alone here.

## Procedure

1. Pick one ratchet and one rule. For ESLint, one rule id such as
   `react-hooks/exhaustive-deps`. The type baseline counts errors per file,
   so pick files whose errors share a cause.
2. Pick a small batch of entries in one directory, for example three files
   under `client/src/components/evals/`. Read that layer's `AGENTS.md`
   (`mcpjam-inspector/client/`, `server/` or `shared/`) first.
3. Fix the code properly. No disable comments, no `@ts-*` directives, no
   `as` casts to silence a checker, no `any`. A missing hook dependency is a
   behaviour question: work out whether the effect should rerun, and test it.
4. Run the check and the tests for the files you touched.
5. Lower the record with the command in the table.
6. Read the record's diff. It may only remove entries or lower counts. If it
   adds an entry or raises a count, the fix introduced a violation or the
   command picked up unrelated drift: fix that before going on.
7. Keep the PR under 800 changed lines (`node scripts/slop/pr-size.mjs`).
   Stop at a batch that fits rather than labelling it large.

## The PR

- One ratchet, one rule, one directory.
- Say what count went from what to what, in the form "`exhaustive-deps`
  suppressions in `client/src/components/evals/`: N to M".
- Say how each fix was verified: the test that covers it, or why none was
  needed.
