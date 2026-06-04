---
"@mcpjam/sdk": minor
---

SDK: add public `Host` builder + portable HostConfig v2 core (`@mcpjam/sdk/host-config`).

Construct a host with MCP-vocabulary fields and serialize a normalized JSON shape:

```ts
import { Host } from "@mcpjam/sdk";

const host = new Host({ style: "mcpjam", model: "anthropic/claude-sonnet-4-6" });
host.mcp.protocolVersion = "2025-11-25";
host.mcp.apps = { sandbox: { csp: { mode: "declared" } } };
host.addServer("srv_abc");

const json = host.toJSON();
```

New public exports (from `@mcpjam/sdk` and `@mcpjam/sdk/host-config`): `Host`, `HostInit`, `HostJson`, `HostMcp`, `HostServerOverride`, `HostConnectionDefaults`, `HostStyleId`, `ServerId`, `CspDomainSet`, `OpenAiAppsCapabilities`, `McpAppsCapabilities`.

Also publishes `@mcpjam/sdk/host-config/internal` — a first-party, non-semver-stable subpath exposing `canonicalizeHostConfigV2`, `computeHostConfigHashV2`, and storage-row types. Intended for first-party consumers (the MCPJam backend, parity-fixture tooling); external SDK users should stay on the `Host` builder.
