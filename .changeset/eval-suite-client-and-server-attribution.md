---
"@mcpjam/sdk": minor
"@mcpjam/inspector": patch
"@mcpjam/cli": patch
---

An API-authored eval suite can name its client, and a server override persists as a name

**A suite created outside the app reported no client and an opaque server id.** The create route had no host input at all, so every CLI-, MCP-, and SDK-authored suite stored an empty client list — leaving the suites list showing a dash, and `run_eval_suite`'s host selector, which only runs hosts ATTACHED to a suite, with nothing to select. `POST /eval-suites` now accepts the same `hosts` array PATCH does, resolving the names before anything is authored and attaching them after, so a bad client name is a clean refusal with no half-created suite. `create_eval_suite` takes `hosts` — the same field name `update_eval_suite` already uses — and `mcpjam cloud eval create` takes `--host`.

The second half is the server column. A suite's environment stores names only when the caller sends `serverNames` beside `serverIds`; the run path sent ids alone, so a suite authored by a run kept displaying a Convex id where a server name belongs. `run_eval_suite` and `run_eval_case` now send the display names paired with the ids, and `computeRunTargets` carries the pair through — dropping the names when they do not line up with the ids, because mislabelling a server is worse than showing its id.
