---
"@mcpjam/inspector": minor
"@mcpjam/sdk": minor
"@mcpjam/cli": patch
---

The saved model selection is the one stored copy of a config's model. Routing and billing read it: a `hosted` selection runs on MCPJam credits, `org` on the organization's connection, `local` on the caller's own provider, and a stored `{ source: "legacy" }` selection means "your own key only" and never runs on MCPJam credits. A config with no selection yet (an older row) keeps today's behaviour exactly until the backend's one-time labelling has run. The v1 API returns `modelSelection` (plus a `modelSelectionOrigin` / `selectionOrigin` / `judgeSelectionOrigin` marker when the platform chose it) on environments, test cases, a suite's execution config and its judge; `modelId` / `model` stay on every response, computed, and stay accepted on input as a shorthand. `requestEvalRunJudge` (and `POST …/eval-runs/{runId}/judge`) accepts `modelSelection` for the run's judge. CLI `--model` and suite-file `model` keep working.
