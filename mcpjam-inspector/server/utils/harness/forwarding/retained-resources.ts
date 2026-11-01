import {
  historyProvenanceContextFor,
  signAppResourceSource,
} from "../../history-provenance";
import type { MCPClientManager } from "@mcpjam/sdk";
import type { ModelToolExecutor } from "../../model-tool-executor";
import {
  getManagerConnections,
  getManagerResourceSnapshot,
} from "../../mcp-connections";
import { createHash } from "node:crypto";
import { canonicalJson } from "../../tool-approval-token";
import { harnessConnectionProfile } from "../harness-connection-profile";
import type { MrtrLegMiddleware } from "@mcpjam/sdk";
import { z } from "zod";
import { retainedResourceBindingSchema } from "@/shared/retained-app-resources";
import { requestExecutionControl } from "./execution-control";

export function readRetainedResourceScope(
  resourceOwner: {
    harnessSessionId: string;
    serverId: string;
    connectionId?: string;
  },
  expectedDigest?: string,
  snapshot?: {
    hostConfigId: string;
    hostId: string;
    serverUpdatedAt: number;
    credentialAuthorizedAt: number | null;
  },
) {
  return requestExecutionControl(
    {
      resourceOwner: {
        harnessSessionId: resourceOwner.harnessSessionId,
        serverId: resourceOwner.serverId,
        ...(resourceOwner.connectionId
          ? { connectionId: resourceOwner.connectionId }
          : {}),
      },
      operation: {
        kind: "resource_scope",
        ...(snapshot ? { snapshot } : {}),
        ...(expectedDigest ? { expectedDigest } : {}),
      },
    },
    z.object({
      binding: retainedResourceBindingSchema,
      expiresAt: z.number(),
      organizationId: z.string(),
      hostConfig: z.record(z.string(), z.unknown()),
    }),
  );
}

/** Continuations stay resource-only and have one send attempt per SDK leg. */
export function retainedResourceLegGate(
  revalidate: () => Promise<void>,
  lifetime: AbortSignal,
): MrtrLegMiddleware {
  const attempted = new Set<string>();
  return async ({ operationId, round, request, signal, send }) => {
    if (
      ![
        "resources/read",
        "resources/list",
        "resources/templates/list",
      ].includes(request.method)
    )
      throw new Error("App resource method changed");
    const key = JSON.stringify([operationId, round]);
    if (attempted.has(key))
      throw new Error("App resource leg already attempted");
    attempted.add(key);
    const active = signal ? AbortSignal.any([signal, lifetime]) : lifetime;
    active.throwIfAborted();
    await revalidate();
    active.throwIfAborted();
    const result = await send();
    await revalidate();
    active.throwIfAborted();
    return result;
  };
}

export function retainedProfileFingerprint(
  manager: import("@mcpjam/sdk").MCPClientManager,
  serverId: string,
) {
  return createHash("sha256")
    .update(canonicalJson(harnessConnectionProfile(manager, serverId)))
    .digest("hex");
}

export type RetainedResourcePresentation = Awaited<
  ReturnType<typeof readRetainedResourceScope>
>["binding"] & { profile: string; attestation: string; turnId?: string };
export function retainedResourceExecutor(args: {
  manager: MCPClientManager;
  enabled: boolean;
  existing?: ModelToolExecutor;
  laneId: () => string | undefined;
  turnId: string;
  sources: Map<string, RetainedResourcePresentation>;
}): ModelToolExecutor | undefined {
  if (args.existing || !args.enabled) return args.existing;
  const prepared = new Map<string, Promise<unknown>>();
  return async (execution, run) => {
    const captured = getManagerResourceSnapshot(
      args.manager,
      execution.serverKey,
    );
    const snapshot = captured
      ? {
          hostId: captured.hostId,
          hostConfigId: captured.hostConfigId,
          serverUpdatedAt: captured.serverUpdatedAt,
          credentialAuthorizedAt: captured.credentialAuthorizedAt,
        }
      : undefined;
    const laneId = args.laneId();
    if (
      snapshot &&
      laneId &&
      args.manager.getInitializationInfo(execution.serverKey)?.transport ===
        "streamable-http"
    ) {
      const selected = Object.values(getManagerConnections(args.manager) ?? {})
        .flat()
        .find((connection) => connection.key === execution.serverKey);
      const connectionId = selected?.connectionId ?? captured?.credentialId;
      const preparationKey = JSON.stringify([
        laneId,
        snapshot.hostId,
        snapshot.hostConfigId,
      ]);
      if (!prepared.has(preparationKey))
        prepared.set(
          preparationKey,
          requestExecutionControl(
            {
              resourceOwner: {
                harnessSessionId: laneId,
                serverId: selected?.serverId ?? execution.serverKey,
              },
              operation: { kind: "prepare_resource_chat", snapshot },
            },
            z.object({ ready: z.literal(true) }),
          ),
        );
      await prepared.get(preparationKey);
      const scope = await readRetainedResourceScope(
        {
          harnessSessionId: laneId,
          serverId: selected?.serverId ?? execution.serverKey,
          ...(connectionId ? { connectionId } : {}),
        },
        undefined,
        snapshot,
      );
      const source = {
        ...scope.binding,
        version: 1 as const,
        toolCallId: execution.toolCallId,
        turnId: args.turnId,
        profile: retainedProfileFingerprint(args.manager, execution.serverKey),
      };
      const provenance = historyProvenanceContextFor(
        source.projectId,
        source.chatSessionId,
      );
      const attestation =
        provenance && signAppResourceSource(provenance, source);
      if (!attestation) throw new Error("App source attestation unavailable");
      args.sources.set(execution.toolCallId, { ...source, attestation });
    }
    return run();
  };
}
