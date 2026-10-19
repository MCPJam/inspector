# AGENTS.md

Run commands from the repo root. Use the Node version in `mcpjam-inspector/.nvmrc`
and install dependencies with `npm install --legacy-peer-deps`.

## Working here

- Before editing `mcpjam-inspector/`, read `mcpjam-inspector/AGENTS.md`.
- Reuse this task's worktree or create one before editing.
- Before writing code beyond a small fix, confirm the Kestral task, spec and
  plan (the PR template's first section). If the spec is missing or unclear,
  ask instead of inventing requirements.
- To run the app: `npm run dev:worktree -w @mcpjam/inspector -- <N> --no-worker`
  (use this in place of `dev:app` in the run-inspector skill).
  Omit `--no-worker` when testing platform MCP tools. Open the printed access
  link and keep its token private. See CONTRIBUTING.md for environment setup.
- Format only changed lines in existing files; the repo is not Prettier-clean.
- Search for existing code before adding helpers: `sdk/` for shared runtime
  code, `mcpjam-inspector/shared/` for client/server utilities,
  `design-system/` for primitives, and `chat-ui/` for chat components.
- Eval and public API names follow `docs/evals-vocabulary-consolidation.md` and
  `docs/public-api-vocabulary-consolidation.md`. Use their canonical terms in
  new code, and never rename the frozen or protected identifiers they list.
- Keep source files under 800 lines and add no root files; CI's repo-hygiene
  check enforces both. Put new logic in its own module behind a small interface.
- No new type escapes, suppressions, swallowed errors, or scratch files.
  Remove obsolete implementations and callers when replacing code.

## Validation

- For code changes, run `npm run slop:check`, the affected workspace's
  typecheck, and tests covering the changed behavior. Expand coverage for
  shared contracts or cross-package changes. Rerun passing checks only when
  relevant code or inputs change.
- Inspector: run `npm run typecheck:client -w @mcpjam/inspector` for client or
  `shared/` code and `npm run typecheck:server -w @mcpjam/inspector` for server
  code. Filter tests with `npm run test -w @mcpjam/inspector -- <path>`; this also
  runs preparation and script tests. For other workspaces, see package.json;
  if `verify` combines checks, run it once.
- For documentation changes, verify referenced paths and commands and run
  `git diff --check`. Skip application builds and tests. If you edit DESIGN.md,
  also run `npm run design:check && npm run design:lint`.
- Report unrelated check failures without expanding the task to fix them.

## UI and generated files

- Read DESIGN.md before UI work. Use `@mcpjam/design-system/*` primitives and
  role tokens, except for the documented chat-ui trace palette.
- Edit colors in `design-system/src/tokens.css`, then run `npm run design:sync`,
  `npm run design:check`, and `npm run design:lint`. Never edit generated mirrors.

## Pull requests

Use `.github/pull_request_template.md`. User-visible changes to releasable
packages need a changeset. Run `npm run slop:size` before opening a PR; base a
stacked PR on the branch below it and add `-- --base <branch below>`.
Read `.agents/skills/` workflows only when relevant to the task.
