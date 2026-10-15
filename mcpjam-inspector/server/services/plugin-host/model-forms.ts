import { modelApps } from "./model-apps.js";
import {
  OPENAI_LEGACY_FORM_EXTENSION,
  OPENAI_LEGACY_FORM_METHOD,
  openAILegacyFormSchemas,
} from "../../../shared/plugin-extensions/wire.js";
import { waitForPluginOperation } from "../../../shared/plugin-operation.js";
import type { MCPClientManagerOptions } from "@mcpjam/sdk";
import { createHash } from "node:crypto";
import type { Context } from "hono";
import type { ModelToolExecutor } from "../../utils/model-tool-executor.js";
import type { PluginWorkspaceAdmission } from "./admission.js";
import { pluginInstances, type PluginInstanceIdentity } from "./instances.js";
import { createPluginRequestRuntime } from "./request-runtime.js";
import { RequestOwnedToolInvoker } from "./request-invoker.js";
import { createPluginInvocationReceiptPort } from "./receipt-store.js";
import {
  PluginInvocationError,
  PluginInvocationSuspension,
} from "./invocation.js";

/** Each original model manager owns its dispatcher. Legacy server requests carry
 * no tool call id, so serialize its gated calls instead of guessing an owner. */
export function createModelFormDispatch(serverIds: readonly string[]) {
  type Handler = (request: {
    params?: Record<string, unknown>;
  }) => Promise<unknown>;
  const active = new Map<string, Handler>();
  const tails = new Map<string, Promise<void>>();
  const handlers = Object.fromEntries(
    serverIds.map((id) => [
      id,
      [
        {
          method: OPENAI_LEGACY_FORM_METHOD,
          schemas: openAILegacyFormSchemas,
          waitsForInput: true,
          // Withheld again if this connection lands on a 2026 era.
          legacyClaim: OPENAI_LEGACY_FORM_EXTENSION,
          handler: (request: { params?: Record<string, unknown> }) => {
            const handler = active.get(id);
            if (!handler) throw new PluginInvocationError("INSTANCE_DENIED");
            return handler(request);
          },
        },
      ],
    ]),
  ) as NonNullable<MCPClientManagerOptions["extensionRequestHandlers"]>;
  return {
    handlers,
    async run<T>(
      serverId: string,
      handler: Handler,
      signal: AbortSignal,
      run: () => Promise<T>,
    ): Promise<T> {
      const previous = tails.get(serverId) ?? Promise.resolve();
      let unlock!: () => void;
      const next = new Promise<void>((resolve) => {
        unlock = resolve;
      });
      const tail = previous.then(() => next);
      tails.set(serverId, tail);
      try {
        await waitForPluginOperation(signal, () => previous);
        signal.throwIfAborted();
        active.set(serverId, handler);
        try {
          return await run();
        } finally {
          if (active.get(serverId) === handler) active.delete(serverId);
        }
      } finally {
        unlock();
        void tail.then(() => {
          if (tails.get(serverId) === tail) tails.delete(serverId);
        });
      }
    },
  };
}

/** Installed only on a real model turn after its normal approval/policy executor.
 * Forms have a model-operation owner, not a fabricated App or entrypoint. */
export function createModelFormExecutor(options: {
  c: Context;
  admission: PluginWorkspaceAdmission;
  identity: PluginInstanceIdentity;
  bearer: string;
  hostId: string;
  hostRevision: string;
  serverIds: readonly string[];
  /** Only independently qualified connection profiles enter this adapter. */
  eligibleServerIds: readonly string[];
  dispatch: ReturnType<typeof createModelFormDispatch>;
}): ModelToolExecutor {
  return async (execution, run) => {
    if (!options.eligibleServerIds.includes(execution.serverKey)) return run();
    if (
      !options.serverIds.includes(execution.serverKey) ||
      !execution.toolCallId ||
      execution.toolCallId.length > 128
    )
      throw new PluginInvocationError("INSTANCE_DENIED");
    const signal = AbortSignal.any([
      options.c.req.raw.signal,
      ...(execution.signal ? [execution.signal] : []),
    ]);
    signal.throwIfAborted();
    const binding = { hostId: options.hostId, serverId: execution.serverKey };
    const discovery = createPluginRequestRuntime(
      options.c,
      options.admission,
      options.bearer,
      binding,
      undefined,
      { ownedForms: false },
    );
    let initial;
    try {
      initial = await discovery.resolve(execution.toolName, signal);
    } finally {
      await discovery.release();
    }
    if (initial.hostRevision !== options.hostRevision)
      throw new PluginInvocationError("INSTANCE_HOST_CHANGED");
    const instance = {
      owner: {
        ...options.identity,
        instanceId: createHash("sha256")
          .update(
            JSON.stringify([
              options.identity,
              options.hostId,
              execution.serverKey,
              execution.toolName,
              execution.toolCallId,
            ]),
          )
          .digest("hex"),
        generation: 1 as const,
        serverId: execution.serverKey,
        bindingId: initial.bindingId,
        placement: "interactive" as const,
      },
      subject: options.identity.subject,
      hostId: options.hostId,
      hostRevision: initial.hostRevision,
      serverIdentity: initial.serverIdentity,
    };
    // Subject belongs to the credential binding, never the serialized owner.
    const { subject: _subject, ...owner } = instance.owner;
    const model = { ...instance, owner };
    const releaseOwner = pluginInstances.retainModelOwner(model, signal);
    const runtime = createPluginRequestRuntime(
      options.c,
      options.admission,
      options.bearer,
      binding,
      model,
    );
    const invoker = new RequestOwnedToolInvoker(owner, () => {
      pluginInstances.getFormOwner(owner, options.identity);
    });
    const params = {
      name: execution.toolName,
      arguments: execution.input as Record<string, unknown>,
    };
    try {
      const result = await invoker.invoke(
        {
          receipts: createPluginInvocationReceiptPort(
            owner,
            options.identity.subject,
          ),
          authorize: async (requestedOwner, origin, next, currentSignal) => {
            if (
              origin !== "model" ||
              next.name !== execution.toolName ||
              requestedOwner.instanceId !== owner.instanceId
            )
              throw new PluginInvocationError("INSTANCE_DENIED");
            const current = await runtime.resolve(next.name, currentSignal);
            if (current.revision !== initial.revision)
              throw new PluginInvocationError("INSTANCE_HOST_CHANGED");
            return {
              owner,
              revision: current.revision,
              enabled: true,
              tool: current.tool,
              allowedOrigins: ["model"],
              requiresApproval: false,
            };
          },
          // Approval already happened in the normal model executor before this callback.
          // This port is deliberately never used to approve a new App/preview effect.
          approve: async () => false,
          admit: (_auth, _id, currentSignal) =>
            options.admission.revalidate({ signal: currentSignal }),
          execute: (auth, _next, currentSignal) =>
            options.dispatch.run(
              execution.serverKey,
              runtime.handleLegacyForm,
              currentSignal,
              () =>
                runtime.runOwnedLegacy(
                  auth,
                  execution.toolCallId,
                  currentSignal,
                  run,
                ),
            ),
          classifyFailure: () => "unknown",
        },
        "model",
        execution.toolCallId,
        params,
        signal,
      );
      if (result instanceof PluginInvocationSuspension)
        throw new PluginInvocationError("CONTINUATION_PROTOCOL_DENIED");
      return modelApps.publish(
        result,
        model,
        execution.toolName,
        initial.revision,
        initial.tool._meta,
      );
    } finally {
      invoker.close();
      await runtime.release();
      releaseOwner();
    }
  };
}
