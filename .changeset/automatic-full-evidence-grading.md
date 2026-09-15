---
"@mcpjam/inspector": minor
---

Display automatic, manual, off, paused and unresolved grading states from the backend policy. Preserve explicit manual/off configuration. Mounting a run no longer requests paid grading.

**Data-egress change:** once the paired backend automatic default is activated, inherited suites send complete recorded traces, tool definitions, runtime context and supported media through OpenRouter to the selected model provider without a separate Run judge click. Existing credential redaction applies. Keep the backend inherited-default override enabled until this client release, data/provider review, platform-paid budget decision and deployment smoke are complete.
