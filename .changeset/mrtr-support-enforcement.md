---
"@mcpjam/sdk": minor
---

Enforce `mcpProfile.mrtrSupport: "none"` — the simulated client no longer
drives MRTR (`resultType: "input_required"`) retry rounds.

New `MCPServerConfig.supportsMrtr`. Setting it `false`:

- **stops advertising `elicitation` on a modern connection**, because the MRTR
  bridge is the only fulfiller on `2026-07-28` and advertising a capability
  nothing can honor breaks advertise = enforce. The suppression reaches the
  `eraCapabilities.modern` overlay and a pinned exact `clientCapabilities` set
  too, so neither can smuggle the capability past the knob.
- **stops driving rounds**: the verb gates resolve no collector, so calls take
  their plain path without `allowInputRequired`, and an `input_required`
  result surfaces as the upstream client's native `UNSUPPORTED_RESULT_TYPE`
  rather than looping. No `allowInputRequired: true` goes out on the wire
  claiming a capability the simulated client disclaims.

Legacy connections are untouched: MRTR does not exist before `2026-07-28`, and
elicitation there is server-initiated and fulfilled by the inbound
`elicitation/create` bridge. The suppression is therefore era-aware rather
than era-blind — implementing it the simple way would have silently disabled a
2025 feature. It is also aware that hosted chat registers a *global*
elicitation callback, which would otherwise have kept the capability
advertised and made the knob a no-op.

Which elicitation modes an MRTR-capable client fulfills remains a separate,
already-modeled fact (`clientCapabilities.elicitation.{form,url}`).
