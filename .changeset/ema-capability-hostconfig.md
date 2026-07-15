---
"@mcpjam/inspector": minor
"@mcpjam/sdk": minor
---

Store MCP Enterprise-Managed Authorization (EMA) capability support at the host level.

- Whether a host advertises the EMA/XAA MCP extension in its `clientCapabilities` is now part of the persisted hostConfig, with a Protocol-tab toggle in the inspector to declare it per host.
- **SDK:** the MCPJam persona seed template now advertises the XAA MCP extension by default (the inspector's own client implements the full SSO assertion → ID-JAG → token redemption path); real-host catalog entries stay silent until those hosts ship support. Connect surfaces still merge the extension at connect time for XAA-configured servers regardless of the stored baseline.
