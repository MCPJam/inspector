---
"@mcpjam/inspector": patch
---

chatboxes: drop the chatbox-level `SessionReadinessStrip` rollup and surface synthetic-session readiness findings (`SessionInsightBar`) directly on the thread detail view instead; derive human-readable issue explanations from denormalized readiness fields when the server omits `issues[]`.
