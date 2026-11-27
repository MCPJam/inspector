---
"@mcpjam/sdk": major
---

A client's MCP Events delivery modes now come only from its saved setting (`mcpProfile.extensions["com.mcpjam/events"]`). Nothing saved, an unreadable setting, or a vendor harness (`agentLoop` or `harness`) means the client receives no events; the MCP Apps style no longer supplies a default.

- Removed `HOST_STYLE_EVENT_DELIVERY_MODES`, `hostStyleEventDeliveryModes` and `clearEventsHostSetting`.
- `resolveHostEventDeliveryModes` and `subscribableModes` change meaning: a host with nothing saved now resolves to no modes. `EventsSupportHost` drops `hostStyle` and gains `harness` and `agentLoop`.
- The seed templates save their Events setting: MCPJam every mode, ChatGPT Work webhook, personal ChatGPT none.
