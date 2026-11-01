import { getManagerOrganization, getManagerResourceSnapshot } from "../../mcp-connections.js";
import type { ToolPolicySnapshot } from "@mcpjam/sdk/contract";
import {
  isCreateTaskExtResult,
  runToolTaskSeam,
  type ToolTaskSeamOptions,
} from "@mcpjam/sdk";
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
import { nativePolicyDigest, forwardingToolPolicy } from "./native-policy.js";
import { readNativeToolResult } from "./native-results.js";
import type { HarnessConnectionProfile } from "../harness-connection-profile.js";
import {
  mergeMcpToolConnectionMetadata,
  mergeMcpWidgetContext,
  mergeMcpOriginalResult,
  type McpConnectionAttribution,
  type McpWidgetExecutionContext,
} from "@/shared/mcp-tool-origin-metadata";

export function nativeToolMetadata(
  forwarding:
    | {
        delivery?: "native" | "bridge";
        widgetContext?: (
          serverId: string,
          callId: string,
        ) => McpWidgetExecutionContext | undefined;
      }
    | undefined,
  serverId: string | undefined,
  callId: string,
  connection: McpConnectionAttribution | undefined,
  originalResult?: unknown,
) {
  return mergeMcpOriginalResult(
    mergeMcpWidgetContext(
      mergeMcpToolConnectionMetadata(undefined, connection),
      serverId ? forwarding?.widgetContext?.(serverId, callId) : undefined,
      forwarding?.delivery,
    ),
    originalResult,
  );
}

export type NativeForwardingSelection = {
  harnessSessionId: string;
  hostId: string;
  servers: Array<{ serverId: string; connectionId?: string }>;
};

export function nativeForwardingSelection(args: {
  manager: MCPClientManager;
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
      // A single default OAuth account has no multi-account UI group. Keep
      // the credential captured by authorization instead of resolving a default later.
      const connectionId = connections[0]?.connectionId ??
        getManagerResourceSnapshot(args.manager, serverId)?.credentialId;
      return { serverId, ...(connectionId ? { connectionId } : {}) };
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
  delivery?: "native" | "bridge";
  profiles?: Record<string, HarnessConnectionProfile>;
  correlationKey?: string;
  tasks?: ToolTaskSeamOptions;
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
  const policyDigest = nativePolicyDigest(
    args.policies,
    args.profiles || args.correlationKey
      ? {
          delivery: args.delivery,
          profiles: args.profiles,
          correlationKey: args.correlationKey,
        }
      : undefined,
  );
  for (const [key, serverId] of Object.entries(keyToServerId)) {
    // The native HTTP request includes the human approval wait at the gate.
    mcpJson.mcpServers[key].timeout = Math.max(
      1000,
      args.expiresAt - Date.now(),
    );
    const owner = args.owners.find(
      (candidate) => candidate.serverId === serverId,
    )!;
    await createExecutionControl({ owner }).bindPolicy(
      args.turnId,
      policyDigest,
    );
    mcpJson.mcpServers[key].headers = {
      // E2B pins injected credentials to the outbound connection. A resumed
      // query must open a new connection after the credential lease rotates.
      Connection: "close",
      "X-MCPJam-Forwarding-Context": sealHarnessProxyToken({
        token: JSON.stringify({
          owner,
          turnId: args.turnId,
          policyDigest,
          ...(args.delivery ? { delivery: args.delivery } : {}),
          ...(args.correlationKey ? { correlationKey: args.correlationKey } : {}),
        }),
        serverId,
        policy: forwardingToolPolicy(args.policies?.[serverId]),
        expiresAtMs: args.expiresAt,
        profile: args.profiles?.[serverId],
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
  const widgetParents = new Map<string, string>();
  const deliveredTasks = new Set<string>();
  return {
    mcpJson,
    delivery: args.delivery ?? "native",
    policyDigest,
    keyToServerId,
    readToolResult: async (serverId: string, toolCallId: string, toolName?: string) => {
      const owner = args.owners.find(
        (candidate) => candidate.serverId === serverId,
      );
      if (!owner)
        throw new Error("The MCP result does not belong to this turn.");
      let sourceExecutionId: string | undefined;
      const result = await readNativeToolResult(
        createExecutionControl({ owner }),
        args.turnId,
        toolCallId,
        (executionId) => {
          sourceExecutionId = executionId;
          widgetParents.set(
            JSON.stringify([serverId, toolCallId]),
            executionId,
          );
        },
      );
      if (
        args.tasks &&
        sourceExecutionId &&
        isCreateTaskExtResult(result) &&
        !deliveredTasks.has(sourceExecutionId)
      ) {
        const executionId = sourceExecutionId;
        await runToolTaskSeam(
          {
            serverId,
            toolName: toolName ?? "Task",
            wire: "extension",
            callPlain: async () => result,
            callEligible: async () => result,
          },
          {
            ...args.tasks,
            resolveIdentity: () => ({
              serverId,
              connectionId: owner.connectionId,
            }),
            onTaskCreated: (event) =>
              args.tasks!.onTaskCreated({
                ...event,
                sourceExecutionId: executionId,
              }),
          },
        );
        deliveredTasks.add(executionId);
      }
      return result;
    },
    widgetContext: (serverId: string, toolCallId: string) => {
      const owner = args.owners.find(
        (candidate) => candidate.serverId === serverId,
      );
      const parentExecutionId = widgetParents.get(
        JSON.stringify([serverId, toolCallId]),
      );
      return owner?.kind === "chat" && parentExecutionId
        ? { owner, parentExecutionId }
        : undefined;
    },
    logScopeIds: Object.fromEntries(
      args.owners.map((owner) => [
        owner.serverId,
        nativeRpcLogScope(owner, args.turnId),
      ]),
    ),
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
  return isForwardingOrganization(getManagerOrganization(manager));
}

export function isForwardingOrganization(
  organizationId?: string | null,
): boolean {
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
