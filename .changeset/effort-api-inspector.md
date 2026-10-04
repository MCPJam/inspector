---
"@mcpjam/inspector": patch
---

The v1 API can now save and read a reasoning effort. A `ModelSelection` (with `settings.reasoningEffort`) is accepted on `PATCH /clients` (`set.modelSelection`), project environments (create, update, ensure-adhoc; the capabilities route reports `modelSelections`), eval cases (`models[].selection`, read back too) and eval suites (`executionConfig.modelSelection`). A `models` PATCH now keeps a case's existing selection for an entry that omits one (it used to erase it; `selection: null` drops it), and a bare suite model change drops a selection saved for a different model instead of failing. `POST /chat-sessions/messages` takes a top-level `reasoningEffort`, pinned on the first turn like `temperature`. `advancedConfig.reasoningEffort`, which nothing ever applied, is now a 400 pointing at `models[].selection.settings`, and the eval runner refuses a stored one. `GET /v1/models` documents `supportedReasoningEfforts`.
