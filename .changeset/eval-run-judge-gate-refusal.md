---
"@mcpjam/inspector": patch
---

Running a suite whose Required judge it cannot honour now shows the backend's reason, such as "A gating judge requires the grading engine in enforce mode…", instead of Convex's raw error text. The local run and replay routes answer 409 with `details.code: JUDGE_GATE_NOT_AVAILABLE` and no longer report the refusal to Sentry. The hosted and API routes answer the same refusal with 409 instead of 400.
