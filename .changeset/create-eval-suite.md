---
"@mcpjam/sdk": minor
"@mcpjam/cli": minor
"@mcpjam/inspector": minor
---

Add `create_eval_suite`: author runnable eval suites from the CLI and MCP.

- **@mcpjam/sdk**: new `createEvalSuiteOperation` platform operation plus
  `PlatformApiClient.createEvalSuite` and the `PlatformEvalSuiteCreated` type.
  Resolves the project selector and HTTP-only servers like `run_eval_suite`,
  and forwards the full case shape (expected tool calls, expected output,
  advanced config, prompt turns, match options, predicates, widget probes).
- **@mcpjam/cli**: new `mcpjam eval` command group (`create` / `list` / `run` /
  `status`). `create` accepts a JSON suite definition via `--file`/`--json`
  with `--name`/`--model`/`--provider`/`--server`/`--project` overrides and
  authors a suite without running it.
- **@mcpjam/inspector**: new author-only `POST /api/v1/projects/:projectId/eval-suites`
  endpoint that creates a runnable suite from test-case definitions (extracted
  from the eval-run path, which is unchanged). The v1 guest gate is now
  method-aware: `GET /eval-suites` stays guest-allowed, `POST` is denied.
