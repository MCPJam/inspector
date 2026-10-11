import { modelApps } from "./model-apps.js";
import { pluginBindingDigest } from "./bindings.js";
import { createHash, randomBytes } from "node:crypto";
import type { Context } from "hono";
import type { UIMessageChunk } from "ai";
import type { MrtrInputCollector } from "@mcpjam/sdk";
import { buildMrtrToolResultMessage } from "../../utils/mrtr-hosted-chat.js";
import type { ModelToolExecutor } from "../../utils/model-tool-executor.js";
import { MrtrSuspendedSignal } from "../../utils/mrtr-hosted-collector.js";
import {
  HOSTED_MRTR_DATA_PART_TYPE,
  type MrtrOwnedModelOperation,
} from "../../../shared/mrtr-continuation.js";
import type { PluginWorkspaceAdmission } from "./admission.js";
import {
  pluginInstances,
  type PluginInstanceIdentity,
  type PluginFormOwner,
} from "./instances.js";
import { createPluginRequestRuntime } from "./request-runtime.js";
import { createModelFormDispatch } from "./model-forms.js";
import { RequestOwnedToolInvoker } from "./request-invoker.js";
import { createPluginInvocationReceiptPort } from "./receipt-store.js";
import {
  PluginInvocationError,
  PluginInvocationSuspension,
  sanitizePluginToolParams,
  type PluginContinuationSubmission,
  type PluginInvocationPorts,
} from "./invocation.js";

type Record = {
  token: string;
  instance: PluginFormOwner;
  identity: PluginInstanceIdentity;
  params: ReturnType<typeof sanitizePluginToolParams>;
  toolCallId: string;
  revision: string;
  invoker: RequestOwnedToolInvoker;
  expiresAt: number;
  pending?: PluginInvocationSuspension;
  close: () => void;
};
// Original engine controls only. No bearer, manager, request or execution callback
// survives a turn. A process restart fails closed rather than replaying an effect.
const records = new Map<string, Record>();
const anchors = new Map<string, string>();
const identityKey = (value: PluginInstanceIdentity) => JSON.stringify(value);
const denied = () => new PluginInvocationError("CONTINUATION_OPERATION_DENIED");

type Options = {
  c: Context;
  admission: PluginWorkspaceAdmission;
  identity: PluginInstanceIdentity;
  bearer: string;
  hostId: string;
  hostRevision: string;
  serverIds: readonly string[];
  modelVisibleMcpToolResults?: import("@mcpjam/sdk").ModelVisibleMcpToolResults;
};
export function createModelMrtrAdapter(options: Options) {
  let writer: { write(chunk: UIMessageChunk): void } | undefined;
  const active = new Map<string, MrtrInputCollector>();
  const queue = createModelFormDispatch([]);
  const getRuntime = (record: Record) =>
    createPluginRequestRuntime(
      options.c,
      options.admission,
      options.bearer,
      { hostId: options.hostId, serverId: record.instance.owner.serverId },
      record.instance,
    );
  const current = (record: Record) => {
    if (
      records.get(record.token) !== record ||
      record.expiresAt <= Date.now() ||
      identityKey(record.identity) !== identityKey(options.identity) ||
      record.instance.hostId !== options.hostId ||
      record.instance.hostRevision !== options.hostRevision ||
      !options.serverIds.includes(record.instance.owner.serverId)
    )
      throw denied();
    pluginInstances.getFormOwner(record.instance.owner, options.identity);
  };
  const emitPending = (record: Record, pending: PluginInvocationSuspension) => {
    current(record);
    record.pending = pending;
    if (!writer)
      throw new PluginInvocationError("CONTINUATION_STREAM_UNAVAILABLE");
    writer.write({
      type: HOSTED_MRTR_DATA_PART_TYPE,
      transient: true,
      data: {
        ...pending.pending,
        kind: "input_required",
        pluginModelOperation: {
          instanceToken: record.token,
          toolCallId: record.toolCallId,
          toolName: record.params.name,
        },
        pluginFormServiceScope: {
          projectId: options.identity.projectId,
          workspaceId: options.identity.workspaceId,
        },
      },
    } as unknown as UIMessageChunk);
  };
  const ports = (
    record: Record,
    runtime: ReturnType<typeof getRuntime>,
    execute: PluginInvocationPorts["execute"],
  ): PluginInvocationPorts => ({
    receipts: createPluginInvocationReceiptPort(
      record.instance.owner,
      options.identity.subject,
    ),
    authorize: async (owner, origin, params, signal) => {
      current(record);
      if (
        origin !== "model" ||
        owner.instanceId !== record.instance.owner.instanceId ||
        params.name !== record.params.name
      )
        throw denied();
      const result = await runtime.resolve(params.name, signal);
      if (result.revision !== record.revision) throw denied();
      return {
        owner,
        revision: result.revision,
        enabled: true,
        tool: result.tool,
        allowedOrigins: ["model"],
        requiresApproval: false,
      };
    },
    // Only reachable inside the already gated normal model executor. Resume
    // continues the same receipt; it cannot authorize a new operation.
    approve: async () => false,
    admit: (_auth, _id, signal) => options.admission.revalidate({ signal }),
    execute,
    classifyFailure: () => "unknown",
  });
  const execute: ModelToolExecutor = async (execution, run) => {
    if (!options.serverIds.includes(execution.serverKey)) return run();
    if (!execution.toolCallId || execution.toolCallId.length > 128)
      throw denied();
    const signal = AbortSignal.any([
      options.c.req.raw.signal,
      ...(execution.signal ? [execution.signal] : []),
    ]);
    const anchor = createHash("sha256")
      .update(
        JSON.stringify([
          options.identity,
          options.hostId,
          execution.serverKey,
          execution.toolName,
          execution.toolCallId,
        ]),
      )
      .digest("hex");
    let record = records.get(anchors.get(anchor) ?? "");
    if (!record) {
      if (records.size >= 512)
        throw new PluginInvocationError("INSTANCE_LIMIT");
      const discovery = createPluginRequestRuntime(
        options.c,
        options.admission,
        options.bearer,
        { hostId: options.hostId, serverId: execution.serverKey },
        undefined,
        { ownedForms: false },
      );
      let initial;
      try {
        initial = await discovery.resolve(execution.toolName, signal);
      } finally {
        await discovery.release();
      }
      if (initial.hostRevision !== options.hostRevision) throw denied();
      const instance: PluginFormOwner = {
        owner: {
          actorId: options.identity.actorId,
          projectId: options.identity.projectId,
          workspaceId: options.identity.workspaceId,
          instanceId: anchor,
          generation: 1,
          serverId: execution.serverKey,
          bindingId: initial.bindingId,
          placement: "interactive",
        },
        subject: options.identity.subject,
        hostId: options.hostId,
        hostRevision: initial.hostRevision,
        serverIdentity: initial.serverIdentity,
      };
      const controller = new AbortController();
      const release = pluginInstances.retainModelOwner(
        instance,
        controller.signal,
      );
      const token = randomBytes(32).toString("base64url");
      const ownerIdentity = structuredClone(options.identity);
      const invoker = new RequestOwnedToolInvoker(instance.owner, () => {
        pluginInstances.getFormOwner(instance.owner, ownerIdentity);
      });
      const close = () => {
        clearTimeout(expiry);
        records.delete(token);
        if (anchors.get(anchor) === token) anchors.delete(anchor);
        invoker.close();
        controller.abort();
        release();
      };
      const expiry = setTimeout(close, 30 * 60_000);
      expiry.unref();
      record = {
        token,
        instance,
        identity: structuredClone(options.identity),
        params: sanitizePluginToolParams({
          name: execution.toolName,
          arguments: execution.input as never,
        }),
        toolCallId: execution.toolCallId,
        revision: initial.revision,
        invoker,
        expiresAt: Date.now() + 30 * 60_000,
        close,
      };
      records.set(token, record);
      anchors.set(anchor, token);
    }
    const original = record;
    if (
      pluginBindingDigest(original.params) !==
      pluginBindingDigest(
        sanitizePluginToolParams({
          name: execution.toolName,
          arguments: execution.input as never,
        }),
      )
    )
      throw denied();
    current(original);
    const runtime = getRuntime(original);
    try {
      const result = await original.invoker.invoke(
        ports(original, runtime, (auth, params, currentSignal) =>
          queue.run(
            execution.serverKey,
            async () => {
              throw denied();
            },
            currentSignal,
            async () => {
              active.set(execution.serverKey, runtime.collectOwnedMrtr);
              try {
                return await runtime.runOwnedModern(
                  auth,
                  original.toolCallId,
                  params,
                  currentSignal,
                  run,
                );
              } finally {
                active.delete(execution.serverKey);
              }
            },
          ),
        ),
        "model",
        original.toolCallId,
        original.params,
        signal,
      );
      if (result instanceof PluginInvocationSuspension) {
        emitPending(original, result);
        throw new MrtrSuspendedSignal(
          result.pending.continuationId as string,
          result.pending.round as number,
        );
      }
      const completed = await runtime.resolve(original.params.name, signal);
      if (completed.revision !== original.revision) throw denied();
      return modelApps.publish(
        result,
        original.instance,
        original.params.name,
        original.revision,
        completed.tool._meta,
      );
    } finally {
      await runtime.release();
    }
  };
  return {
    execute,
    attachStreamWriter(next: { write(chunk: UIMessageChunk): void }) {
      writer = next;
    },
    collectorForServer(serverId: string): MrtrInputCollector | undefined {
      if (!options.serverIds.includes(serverId)) return undefined;
      return (args) => {
        const collector = active.get(serverId);
        if (!collector) throw denied();
        return collector(args);
      };
    },
    async resume(
      owned: MrtrOwnedModelOperation,
      submission: PluginContinuationSubmission,
      serverId: string,
    ) {
      const record = records.get(owned.instanceToken);
      if (!record) throw denied();
      current(record);
      if (
        owned.toolCallId !== record.toolCallId ||
        owned.toolName !== record.params.name ||
        serverId !== record.instance.owner.serverId ||
        !record.pending ||
        submission.continuationId !== record.pending.pending.continuationId ||
        submission.round < 1 ||
        submission.round > record.pending.pending.round
      )
        throw denied();
      const runtime = getRuntime(record);
      try {
        const invokePorts = ports(record, runtime, async () => {
          throw denied();
        });
        invokePorts.continuation = {
          submission,
          resume: (auth, params, signal) =>
            runtime.resumeMrtr(
              auth,
              record.toolCallId,
              params,
              submission,
              signal,
            ),
        };
        const result = await record.invoker.invoke(
          invokePorts,
          "model",
          record.toolCallId,
          record.params,
          options.c.req.raw.signal,
        );
        if (result instanceof PluginInvocationSuspension) {
          emitPending(record, result);
          return {
            kind: "suspended" as const,
            round: result.pending.round as number,
          };
        }
        const manager = runtime.manager();
        if (!manager) throw denied();
        try {
          await manager.assertMrtrToolOutputSchema(
            serverId,
            record.params.name,
            result as never,
          );
        } catch {
          writer?.write({
            type: HOSTED_MRTR_DATA_PART_TYPE,
            transient: true,
            data: {
              kind: "resolved",
              version: 1,
              continuationId: submission.continuationId,
              outcome: "completed",
              pluginModelOperation: owned,
            },
          } as unknown as UIMessageChunk);
          return {
            kind: "recover" as const,
            reason: "Tool result did not satisfy its declared schema",
            toolResultMessage: {
              role: "tool",
              content: [
                {
                  type: "tool-result",
                  toolCallId: record.toolCallId,
                  toolName: record.params.name,
                  output: {
                    type: "error-text",
                    value: "Tool result did not satisfy its declared schema",
                  },
                },
              ],
            } as import("ai").ModelMessage,
          };
        }
        const completed = await runtime.resolve(
          record.params.name,
          options.c.req.raw.signal,
        );
        if (completed.revision !== record.revision) throw denied();
        const published = modelApps.publish(
          result,
          record.instance,
          record.params.name,
          record.revision,
          completed.tool._meta,
        );
        const toolResultMessage = await buildMrtrToolResultMessage(
          record.toolCallId,
          record.params.name,
          serverId,
          published as never,
          options.modelVisibleMcpToolResults,
          manager,
        );
        writer?.write({
          type: HOSTED_MRTR_DATA_PART_TYPE,
          transient: true,
          data: {
            kind: "resolved",
            version: 1,
            continuationId: submission.continuationId,
            outcome: "completed",
            pluginModelOperation: owned,
          },
        } as unknown as UIMessageChunk);
        return { kind: "complete" as const, toolResultMessage };
      } finally {
        await runtime.release();
      }
    },
  };
}
