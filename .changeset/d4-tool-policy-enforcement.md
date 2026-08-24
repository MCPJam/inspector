---
"@mcpjam/inspector": patch
"@mcpjam/sdk": patch
---

Enforce eval tool policies at execution time with visible-but-blocked tools,
recording policy blocks without treating them as eval failures. Hosted
platform-authored suites still lack the backend policy field and remain
unsupported by the hosted CLI. Harness evals are refused at launch until D4b,
and run summaries report the number of iterations with calls blocked by policy.
