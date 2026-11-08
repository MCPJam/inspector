---
"@mcpjam/inspector": patch
---

Load structured settings after hosted request budgeting reads the request body. Reuse Hono's cached JSON instead of cloning the consumed body; validation and admission checks remain in place.
