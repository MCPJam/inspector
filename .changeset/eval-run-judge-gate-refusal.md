---
"@mcpjam/inspector": patch
---

Running a suite whose Required judge it cannot honour now shows the backend's reason, such as "A gating judge requires the grading engine in enforce mode…", instead of Convex's raw error text. The local run and replay routes answer 409 with `details.code: JUDGE_GATE_NOT_AVAILABLE` and no longer report the refusal to Sentry. Every other refusal the backend sends those two routes, coded with a message (400 unless it has its own status) or an authorization refusal (403), also reaches the caller with its own message instead of a 500 and is no longer reported. The hosted and API routes answer the judge-gate refusal with 409 instead of 400.
