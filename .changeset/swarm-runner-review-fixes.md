---
"@mcpjam/inspector": patch
"@mcpjam/sdk": patch
---

Swarm starter funding is safer end to end. A step the backend refuses as `swarm_starter_rejected` (including a `duplicate`) now ends that session as `starter_step_rejected`: a failed attempt that is still graded, never retried and never shown as a credits problem, and a setup turn refused that way is not run again. A target's setup runs on MCPJam's money only when the create response planned a starter session for it and the target's first claim confirms it; otherwise it sets up on credits. After a credit-only spend-cap stop, each remaining credit session is read off its own claim and records the cap on its own attempt, so a run whose starter sessions finished is no longer reported as spend-capped as a whole; a run with no starter sessions still is. The host step's output ceiling is sent only on the MCPJam-hosted rail, the held-credits exclusion in credit-exhaustion detection reads only the refusal's own top-level words, and the launch quote (API, OpenAPI and SDK) accepts at most 100 planned runs and 10 environments per run.
