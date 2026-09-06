---
"@mcpjam/inspector": patch
---

The simple case editor is now owned by the Evaluate surface: it lives in `components/evaluate/simple-case/` and is switched on by an `evaluateCaseEditor` prop that only `EvaluateTab` passes, replacing the `eval-simple-case-editor` PostHog flag.
