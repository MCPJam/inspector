---
"@mcpjam/inspector": patch
"@mcpjam/sdk": minor
---

Results compare by effort, temperature, source and connection, not just by model id. Runs and iterations carry a `targetKey` (the model id for a default selection, so existing history is unchanged), and the evals tab keys columns, baselines, deltas, the case timeline, lanes, filters and Performance by Model by it, labelling only what differs ("Sonnet 5.5 · High" vs "· Low"). The SDK adds `comparisonKey`, `isDefaultSelection`, `selectionDistinguishers`, `executionVariantSelectionKey` and `defaultReasoningEffort`, and an eval execution variant gains an optional `selectionKey` (set only for a non-default selection, so every existing verdict key is unchanged). `--compose-model-selection` and `run_eval_suite` compose accept several selections of one model. The case editor counts an effort-only edit as a change.
