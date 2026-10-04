---
"@mcpjam/inspector": patch
---

Eval UIs read and write a reasoning effort, and two efforts of one model are two targets. The suite run matrix and suite clients settings seed one cell per target (`comparisonKey`) instead of folding efforts of one model into one cell, each model chip has "Add another effort", and both efforts save as two environments; labels add only what differs ("Sonnet 4.5 · Low" / "· High"). They reuse an environment only while its selection is unchanged and send the picked model's whole selection (source, connection and effort) when they build a new environment. The run review lists each environment's effort, and a case's Setup Run sheet on an environment suite shows the environment's effort read-only (the environment wins). Removes the dead compare-override `providerFlagsJson`, the unused `CaseSuiteChips` component and the raw model input of the unused `ClientConfigEditor`.
