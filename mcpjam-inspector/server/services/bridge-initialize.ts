import type { MCPClientManager } from "@mcpjam/sdk";
import { downstreamProtocolVersionOf } from "./bridge-protocol-version.js";
import type { BridgeMode } from "./mcp-http-bridge.js";

/** The version a bridge answers with when the client asked for none it speaks. */
const FALLBACK_PROTOCOL_VERSION = "2025-06-18";

/** What a bridge declares for a server that has not connected yet. */
function standInInitializeResult(serverId: string, mode: BridgeMode) {
  if (mode === "adapter") {
    return {
      capabilities: {
        tools: { listChanged: true },
        prompts: {},
        resources: { listChanged: true, subscribe: true },
        logging: {},
        roots: { listChanged: true },
      },
      serverInfo: { name: serverId, version: "stdio-adapter" },
    };
  }
  return {
    capabilities: {
      tools: true,
      prompts: true,
      resources: true,
      logging: false,
      elicitation: {},
      roots: { listChanged: true },
    },
    serverInfo: { name: serverId, version: "mcpjam-proxy" },
  };
}

/**
 * A bridge's answer to `initialize`. It mirrors the connected server's own
 * handshake (capabilities, serverInfo, instructions), so a remote client
 * negotiates against what that server supports, and it answers in the
 * version the client asked for when the bridge speaks it. MCPJam's own client
 * negotiated the upstream separately, and a 2025 client answered in another
 * version may not recover.
 */
export function bridgeInitializeResult(args: {
  serverId: string;
  mode: BridgeMode;
  manager: Pick<MCPClientManager, "getInitializationInfo">;
  params: unknown;
  downstreamProtocolVersion?: string;
}): Record<string, unknown> {
  const requested =
    args.downstreamProtocolVersion ??
    downstreamProtocolVersionOf({ method: "initialize", params: args.params });
  const info = args.manager.getInitializationInfo(args.serverId);
  if (!info) {
    return {
      protocolVersion: requested ?? FALLBACK_PROTOCOL_VERSION,
      ...standInInitializeResult(args.serverId, args.mode),
    };
  }
  const offered = (args.params as { protocolVersion?: unknown } | undefined)
    ?.protocolVersion;
  return {
    protocolVersion:
      args.downstreamProtocolVersion ??
      info.protocolVersion ??
      (typeof offered === "string" ? offered : FALLBACK_PROTOCOL_VERSION),
    capabilities: info.serverCapabilities ?? {},
    serverInfo: info.serverVersion ?? {
      name: args.serverId,
      version: "unknown",
    },
    ...(info.instructions !== undefined
      ? { instructions: info.instructions }
      : {}),
  };
}
