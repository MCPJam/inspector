---
"@mcpjam/inspector": patch
"@mcpjam/sdk": patch
"@mcpjam/cli": patch
---

Unbreak harness eval runs that carry skills, and make skill IDs obtainable without the web app.

A harness eval run whose environment or suite pinned any skill failed at setup with `tokensUsed: 0` — its pins reached `prepareChatV2`, which refuses them because a harness already receives skills as SKILL.md on the box. Both iteration paths now route that decision through one seam, and the refusal's message says what to pass instead. Turn-end skill adoption is no longer allowed out of a pinned turn, where it could write an agent-authored skill back into the pool the next A/B arm resolves against.

A `skills-enabled` gate refusal now surfaces as a 403 carrying the backend's message instead of an opaque `Server Error` 500.

Adds a read-only Cloud Skills surface — `GET /v1/projects/:projectId/skills` and `/skills/:skillId`, the matching SDK operations, and `mcpjam cloud skills list|get` — so the skill IDs that `--compose-skill` and an environment's `skillSelection` demand can be discovered from the CLI and MCP catalog. Authoring stays an app flow.
