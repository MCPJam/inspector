---
"@mcpjam/sdk": minor
"@mcpjam/cli": minor
"@mcpjam/inspector": minor
---

The default eval pass threshold is now 70% instead of 100%. A suite with no threshold of its own passes a run when at least 70% of it passes. `LEGACY_SUITE_WIDE_THRESHOLD_PERCENT` is now `70`, so the reporter's local fallback, `cloud eval export` (`passThreshold: 0.7`) and the inspector's rerun and replay follow it. Suites with a threshold you set keep it, and past runs keep the result they were judged at.
