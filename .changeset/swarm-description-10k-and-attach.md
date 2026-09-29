---
"@mcpjam/sdk": patch
"@mcpjam/inspector": patch
---

Swarm audience descriptions now accept up to 10,000 characters instead of 2,000.

The create flow's Describe box shows a live character count and blocks Continue past the cap, instead of failing on submit with "description: Too big". A `.txt` or `.md` file of user research can be attached from a button or dropped on the box; its text is appended under the same count. The web and `/v1` generation routes, `create_swarm` / `update_swarm`, and the SDK/CLI `generate_personas` / `generate_goals` operations share the new cap.
