---
"@mcpjam/inspector": minor
---

Inspector feature batch since the last release:

- WebMCP agent tool surfaces: hosts, computer, chatboxes, swarms, evals, registry, primitives (resources/prompts/tools), playground, plus surface tool-group foundation and outcome telemetry.
- The in-app agent acts only through the UI: app map from surface manifests, per-turn location, cross-screen observation, and annotation-gated `ui_*` approval.
- Swarm journeys: live SSE streaming, evals-style matrix, journey-scoped server groups, persona avatars, and anonymous personal-org access.
- Dynamic model catalog served in hosted mode and to the client, with guests un-gated.
- Hosted elicitation: form dialog, URL consent, gating, and `-32042` surfacing, plus the client-capability toggle.
- User-facing "Hosts" → "Clients" rename and assorted fixes (sidebar sign-in in local/npx, Connect nav overlap, tri-selector active state, logger copy button, upload-quota enforcement).
