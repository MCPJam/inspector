import {
  historyProvenanceContextFor,
  signAppResourceSource,
} from "../../history-provenance";
import { isChatGPTAppTool, isMcpAppTool, type MCPClientManager } from "@mcpjam/sdk";
import type { ModelToolExecution, ModelToolExecutor } from "../../model-tool-executor";
import { logger } from "../../logger";
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
import { ExecutionControlError, requestExecutionControl } from "./execution-control";

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
>["binding"] & { profile: string; attestation: string; turnId?: string; connectionCapabilities?: Record<string, unknown> };
/** An MCP-UI result carries its App inline, so only its output says it has one. */
function hasInlineUiResource(result: unknown): boolean {
  const content = z.object({ content: z.array(z.unknown()) }).safeParse(result);
  return (
    content.success &&
    content.data.content.some((item) => {
      const resource = z
        .object({ type: z.literal("resource"), resource: z.object({ uri: z.string() }) })
        .safeParse(item);
      return resource.success && resource.data.resource.uri.startsWith("ui://");
    })
  );
}

/**
 * Bind each App a host-executed call renders to the account that produced it.
 *
 * The signed source only serves the App's own later resource reads and tool
 * calls, so it never decides whether the call runs: the call always runs, a
 * declared App is bound alongside it, and a call whose App could not be bound
 * is listed in `refused`, so its App shows a note instead of falling back to
 * whichever account is selected later.
 */
export function retainedResourceExecutor(args: {
  manager: MCPClientManager;
  enabled: boolean;
  existing?: ModelToolExecutor;
  laneId: () => string | undefined;
  turnId: string;
  sources: Map<string, RetainedResourcePresentation>;
  refused?: Set<string>;
}): ModelToolExecutor | undefined {
  if (!args.enabled) return args.existing;
  const prepared = new Map<string, Promise<unknown>>();
  const prepareChat = async (key: string, request: object) => {
    const pending =
      prepared.get(key) ??
      requestExecutionControl(request, z.object({ ready: z.literal(true) }));
    prepared.set(key, pending);
    try {
      await pending;
    } catch (error) {
      // Only a ready chat is shared; the next App call asks again.
      if (prepared.get(key) === pending) prepared.delete(key);
      throw error;
    }
  };
  const target = (execution: ModelToolExecution) => {
    const captured = getManagerResourceSnapshot(args.manager, execution.serverKey);
    const laneId = args.laneId();
    if (
      !captured ||
      captured.headersReconstructible !== true ||
      !laneId ||
      args.manager.getInitializationInfo(execution.serverKey)?.transport !==
        "streamable-http"
    )
      return undefined;
    return {
      captured,
      laneId,
      snapshot: {
        hostId: captured.hostId,
        hostConfigId: captured.hostConfigId,
        serverUpdatedAt: captured.serverUpdatedAt,
        credentialAuthorizedAt: captured.credentialAuthorizedAt,
      },
    };
  };
  const bind = async (
    execution: ModelToolExecution,
    { captured, laneId, snapshot }: NonNullable<ReturnType<typeof target>>,
  ) => {
    const selected = Object.values(getManagerConnections(args.manager) ?? {})
      .flat()
      .find((connection) => connection.key === execution.serverKey);
    const connectionId = selected?.connectionId ?? captured.credentialId;
    const serverId = selected?.serverId ?? execution.serverKey;
    await prepareChat(
      JSON.stringify([laneId, snapshot.hostId, snapshot.hostConfigId]),
      {
        resourceOwner: { harnessSessionId: laneId, serverId },
        operation: { kind: "prepare_resource_chat", snapshot },
      },
    );
    const scope = await readRetainedResourceScope(
      {
        harnessSessionId: laneId,
        serverId,
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
      // Preserve the negotiated declaration, including capabilities withheld
      // by installed handlers for this server's protocol era.
      connectionCapabilities: structuredClone(
        harnessConnectionProfile(args.manager, execution.serverKey).clientCapabilities,
      ),
    };
    const provenance = historyProvenanceContextFor(
      source.projectId,
      source.chatSessionId,
    );
    const attestation =
      provenance && signAppResourceSource(provenance, source);
    if (!attestation) throw new Error("App source attestation unavailable");
    args.sources.set(execution.toolCallId, { ...source, attestation });
  };
  const settle = (binding: Promise<void>) =>
    binding.then(
      () => undefined,
      (error: unknown) => ({ error }),
    );
  return async (execution, run) => {
    const execute = () => (args.existing ? args.existing(execution, run) : run());
    const bindable = target(execution);
    if (!bindable) return execute();
    const declared = args.manager.getToolMetadata(execution.serverKey, execution.toolName);
    let binding =
      isMcpAppTool(declared) || isChatGPTAppTool(declared)
        ? settle(bind(execution, bindable))
        : undefined;
    // Settled before the call's outcome returns, even when the call throws, so
    // the source or refusal is recorded before the turn reads this result.
    try {
      const result = await execute();
      binding ??= hasInlineUiResource(result)
        ? settle(bind(execution, bindable))
        : undefined;
      return result;
    } finally {
      const refusal = await binding;
      if (refusal) {
        args.refused?.add(execution.toolCallId);
        logger.warn("[harness] App result left unbound; the tool result stands", {
          serverId: execution.serverKey,
          toolName: execution.toolName,
          ...(refusal.error instanceof ExecutionControlError
            ? { code: refusal.error.code, reason: refusal.error.reason }
            : {
                error:
                  refusal.error instanceof Error ? refusal.error.name : "unknown",
              }),
        });
      }
    }
  };
}
