---
"@mcpjam/inspector": patch
---

Environment suites generate, import and edit from their environments.

- Case generation writes cases for one environment's servers (its group plus pinned plugin servers), resolved server-side. A suite whose environments connect different servers asks which one: in the Generate dialog, the Generate options popover and the Import dialog, and through `environment` on the agent's `ui_generate_eval_tests` (the app snapshot lists the suite's environments). The pick is remembered per suite. Generation never uses the union of a mixed suite's tools or the suite's legacy server fields.
- The suites list's Run, the suite header, the case list and the case sidebar decide "has servers" from the environments, and no longer require the browser to connect an environment suite's servers before a case run.
- "Where it runs" saves through `testSuites:deriveSuiteEnvironments` when the backend advertises `environmentDerivation`: new cells are derived from the stored source environment (plugin pins, captured server skills and secret grants survive), the suite is repointed in the same transaction, and an edit racing another is refused. When a new client or model's candidate setups differ, the editor asks which one to copy instead of refusing. The run dialog's one-run combinations derive the same way without modifying the suite. Older backends keep the previous refusals.
