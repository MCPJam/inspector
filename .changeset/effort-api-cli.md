---
"@mcpjam/cli": minor
---

`--effort <level>` (and `--clear-effort`) on `clients update`, `environments update` and `eval update` edits the reasoning effort on the target's existing model selection; `sessions send --effort` sets a per-request effort pinned on the session's first turn. `--set modelSelection=<json>` (clients), `--model-selection <json>` (`environments create` / `update` / `ensure-adhoc`, `eval update`) and `--compose-model-selection <json>` (`eval run`, `eval cases run`) send a whole saved selection. An effort the route cannot apply is refused, never dropped, and a deployment that predates saved selections is refused with a message instead of an opaque validator error.
