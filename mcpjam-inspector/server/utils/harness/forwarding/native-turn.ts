import { getManagerOrganization } from "../../mcp-connections.js";
import type { ToolPolicySnapshot } from "@mcpjam/sdk/contract";
import type { ConnectionsByServerId, MCPClientManager } from "@mcpjam/sdk";
import type { ChunkWriter } from "../../chat-stream-chunks.js";
import {
  resolveHarnessProxyUrl,
  type HarnessMcpProxyStrategy,
} from "../harness-proxy-strategy.js";
import {
  buildHarnessProxyMcpJson,
  harnessServerKeyToName,
} from "../mcp-config.js";
import { sealHarnessProxyToken } from "../harness-proxy-policy-seal.js";
import {
  createExecutionControl,
  forwardingOwnerSchema,
  type ForwardingOwner,
} from "./execution-control.js";
import { startForwardingApprovalPresentation } from "./approval.js";
import { nativeRpcLogScope } from "./native-rpc-logs.js";

export type NativeForwardingSelection = {
  harnessSessionId: string;
  hostId: string;
  servers: Array<{ serverId: string; connectionId?: string }>;
};

export function nativeForwardingSelection(args: {
  laneId?: string;
  hostId?: string;
  serverIds: string[];
  connections: ConnectionsByServerId;
}): NativeForwardingSelection {
  if (!args.laneId || !args.hostId || !args.serverIds.length)
    throw new Error(
      "Native forwarding requires an owned chat lane and selected servers.",
    );
  return {
    harnessSessionId: args.laneId,
    hostId: args.hostId,
    servers: args.serverIds.map((serverId) => {
      const connections = args.connections[serverId] ?? [];
      if (connections.length > 1)
        throw new Error(
          "Native forwarding currently requires one account per server.",
        );
      return {
        serverId,
        ...(connections[0]
          ? { connectionId: connections[0].connectionId }
          : {}),
      };
    }),
  };
}

/** Build only from backend-confirmed owners. No signed grant enters the VM. */
export async function prepareNativeForwarding(args: {
  owners: ForwardingOwner[];
  origin: string;
  expiresAt: number;
  turnId: string;
  promptIndex?: number;
  strategy: HarnessMcpProxyStrategy;
  authHeader: string;
  policies?: Record<string, ToolPolicySnapshot>;
  writer: ChunkWriter;
}) {
  if (args.strategy.plane !== "web-authorized" || !args.owners.length)
    throw new Error("Native forwarding route is unavailable.");
  const inputs = await Promise.all(
    args.owners.map(async (owner) => {
      const url = new URL(
        await resolveHarnessProxyUrl({
          strategy: args.strategy,
          serverId: owner.serverId,
          authHeader: args.authHeader,
        }),
      );
      if (url.protocol !== "https:" || url.origin !== args.origin)
        throw new Error(
          "Native forwarding origin differs from the sandbox credential binding.",
        );
      url.searchParams.set("native", "1");
      return { name: owner.serverId, proxyUrl: url.toString() };
    }),
  );
  const mcpJson = buildHarnessProxyMcpJson(inputs);
  const keyToServerId = harnessServerKeyToName(inputs);
  for (const [key, serverId] of Object.entries(keyToServerId)) {
    // The native HTTP request includes the human approval wait at the gate.
    mcpJson.mcpServers[key].timeout = Math.max(1000, args.expiresAt - Date.now());
    const owner = args.owners.find(
      (candidate) => candidate.serverId === serverId,
    )!;
    mcpJson.mcpServers[key].headers = {
      "X-MCPJam-Forwarding-Context": sealHarnessProxyToken({
        token: JSON.stringify({ owner, turnId: args.turnId }),
        serverId,
        policy: args.policies?.[serverId] ?? {
          mode: "default",
          denied: {},
          known: [],
          unknownTool: "allow",
        },
        expiresAtMs: args.expiresAt,
      }),
    };
  }
  const stop = args.owners.map((owner) =>
    startForwardingApprovalPresentation({
      control: createExecutionControl({ owner }),
      owner,
      turnId: args.turnId,
      promptIndex: args.promptIndex,
      writer: args.writer,
    }),
  );
  return {
    mcpJson,
    keyToServerId,
    logScopeIds: Object.fromEntries(args.owners.map((owner) =>
      [owner.serverId, nativeRpcLogScope(owner, args.turnId)])),
    stop: async () => {
      await Promise.all(stop.map((fn) => fn()));
    },
    isForwardedTool: (name?: string) =>
      !!name &&
      Object.keys(keyToServerId).some((key) =>
        name.startsWith(`mcp__${key}__`),
      ),
  };
}

/** Rollout uses the organization resolved by hosted authorization, never the request body. */
export function hasForwardingOrganization(manager: MCPClientManager): boolean {
  const organizationId = getManagerOrganization(manager);
  return (
    !!organizationId &&
    (process.env.HARNESS_FORWARDING_ORGANIZATION_IDS ?? "")
      .split(",")
      .map((id) => id.trim())
      .includes(organizationId)
  );
}

/** Missing or mismatched backend ownership must revoke the newly installed lease. */
export function readNativeForwardingResult(
  payload: unknown,
  selected?: NativeForwardingSelection,
): { owners: ForwardingOwner[]; origin: string } | undefined | null {
  if (!selected) return undefined;
  if (
    !payload ||
    typeof payload !== "object" ||
    !("forwardingOwners" in payload) ||
    !("forwardingOrigin" in payload)
  )
    return null;
  const owners = forwardingOwnerSchema
    .array()
    .min(1)
    .safeParse(payload.forwardingOwners);
  if (
    !owners.success ||
    typeof payload.forwardingOrigin !== "string" ||
    owners.data.length !== selected.servers.length ||
    !selected.servers.every((server) =>
      owners.data.some(
        (owner) =>
          owner.kind === "chat" &&
          owner.harnessSessionId === selected.harnessSessionId &&
          owner.serverId === server.serverId &&
          owner.connectionId === server.connectionId,
      ),
    )
  )
    return null;
  return { owners: owners.data, origin: payload.forwardingOrigin };
}
