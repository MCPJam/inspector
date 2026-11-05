---
"@mcpjam/inspector": patch
---

A hosted deployment can run the claim loops (scheduled evals, GitHub checks, Connector Bench and production scoring) in their own worker service: `MCPJAM_PROCESS_ROLE=web` serves HTTP without them, and `MCPJAM_PROCESS_ROLE=worker` runs them and refuses to start without the service credential or, in hosted mode, a public https origin. Unset, a server does both, as before. See `mcpjam-inspector/docs/worker-deployment.md`.
