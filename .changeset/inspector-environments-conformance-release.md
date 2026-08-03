---
"@mcpjam/inspector": minor
---

Release the inspector app changes that have accumulated since 2.32.0.

- **Environments** become the execution context the rest of the product builds
  on: swarm personas and journeys are generated against an environment and
  journeys are environments-only, chatboxes can be published from an
  environment with full admin parity, the playground lists the environment's
  servers and tools, the Skills section is gated behind `skills-enabled`, and
  the tab is allowed in hosted mode.
- **Ephemeral sandboxes** for bash: per-conversation for chatbox, per-attempt
  for swarm runs and harnesses, with the `MCPJAM_SWARM_EPHEMERAL_BASH` flag
  removed.
- **GitHub PR checks**: recipe resolver ladder R1/R2 (override, declared
  `mcpjam.yaml`, rung-2 detection with a pinned corpus harness),
  `resolveAndStart` wiring with a fresh box per candidate, and
  check-triggered runs labeled `github_check`.
- **SEP-2243 `Mcp-Param-*`**: product-wide enforcement of the mirroring knob,
  mirrored headers on MRTR tool legs, and hosted HTTP-header delivery with
  headers shown inline on JSON-RPC frames.
- **Agent**: headless turn endpoint
  (`POST /api/v1/projects/:projectId/agent`), `ui_ask_user` for inline
  clarifying questions, and the MCP spec docs server connected for protocol
  questions.
- **Fixes**: stop stripping `url` elicitation mode from modern local
  connections, stable RPC log event ids so replayed rows do not duplicate,
  agent suite authoring no longer fails with an opaque validation error,
  `?project=` deep links land on the right project, and corrected
  bind-address claims in the checks bridge.
- Pre-run credit estimates before launching evals and swarms, plus pricing
  table copy for the 3x eval iteration quotas.
