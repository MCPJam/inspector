---
"@mcpjam/inspector": patch
---

Eval UIs read and write a reasoning effort. The suite run matrix and suite clients settings show an effort chip per explicit model in the target matrix, seed from each environment's own saved selection, reuse an environment only while its effort is unchanged, and send the picked model's whole selection (source, connection and effort) when they build a new environment; suite clients settings used to drop it to a bare model id. The run review lists each environment's effort, and a case's Setup Run sheet on an environment suite shows the environment's effort read-only (the environment wins). Removes the dead compare-override `providerFlagsJson` (its `reasoningEffort` claim never reached the runner), the unused `CaseSuiteChips` component and the raw model input of the unused `ClientConfigEditor`.
