---
"@mcpjam/inspector": patch
---

When a Free organization has used its free native harness turns, a native turn refused in the Playground, an eval or a swarm now opens a "Keep using native harnesses" dialog. People who manage billing can upgrade from it, and everyone else can email an owner to ask. A swarm refused this way stops as it does at an organization spend cap. On a User Testing link, the tester is told the study's owner has run out. For members who can run a native harness, the sidebar credits card and the organization usage card show the native harness turns left. The API answers the refusal with `FORBIDDEN`, the reason `native_harness_trial_exhausted` and the billing page.
