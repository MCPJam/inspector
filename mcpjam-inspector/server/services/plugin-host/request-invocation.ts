import type { Context } from "hono";
import { captureServerEvent } from "../../utils/analytics.js";
import {
  claimToolApproval,
  mintToolApprovalId,
  verifyToolApprovalId,
} from "../../utils/tool-approval-token.js";
import {
  classifyPluginToolFailure,
  PluginInvocationError,
  PluginInvocationSuspension,
  createPluginAdmissionNoop,
  sanitizePluginToolParams,
  type PluginInvocationOrigin,
  type PluginInvocationPorts,
  type PluginToolCallParams,
} from "./invocation.js";
import {
  pluginResolverIncludesAdmission,
  type PluginWorkspaceAdmission,
} from "./admission.js";
import type {
  PluginInstanceIdentity,
  PluginInstanceAdmissionRead,
  PluginInstanceInvocationPorts,
} from "./instances.js";
import type { createPluginRequestRuntime } from "./request-runtime.js";
import { createPluginInvocationReceiptPort } from "./receipt-store.js";
import { timedPluginStep } from "./timing.js";

type Runtime = ReturnType<typeof createPluginRequestRuntime>;
type Resolved = Awaited<ReturnType<Runtime["resolve"]>>;

/** The server returned a JSON-RPC error for the tool call. Its message is the
 * server's own text (bounded), returned to the caller as `message`. */
export class PluginToolCallFailure extends PluginInvocationError {
  readonly serverMessage?: string;
  readonly serverCode?: number;
  constructor(error: unknown) {
    super("TOOL_CALL_FAILED");
    const value = error as { message?: unknown; code?: unknown };
    if (typeof value?.message === "string")
      this.serverMessage = value.message.slice(0, 500);
    if (typeof value?.code === "number") this.serverCode = value.code;
  }
}

/** Shared HTTP approval/dispatch/delivery path for rendered and headless owners. */
export async function invokePluginRequest(
  c: Context,
  input: {
    actor: PluginInstanceIdentity;
    owner: import("./invocation.js").TrustedInvocationOwner;
    admission: PluginWorkspaceAdmission;
    runtime: Pick<Runtime, "manager" | "release"> &
      Partial<Pick<Runtime, "executeOwned" | "resumeMrtr" | "diagnostics">>;
    resolve: (
      name: string,
      signal: AbortSignal,
      read?: PluginInstanceAdmissionRead,
    ) => Promise<Resolved>;
    assertOrigin: (resolved: Resolved) => void;
    assertLive: () => void;
    invoke: (
      ports: PluginInstanceInvocationPorts,
      params: PluginToolCallParams,
    ) => Promise<unknown>;
    resume?: import("./invocation.js").PluginContinuationSubmission;
    origin: PluginInvocationOrigin;
    invocationId: string;
    params: PluginToolCallParams;
    approval?: { id: string; approved: boolean };
    /** Feature validation is compiled before dispatch and fenced by the same revision. */
    validate?: (resolved: Resolved) => (result: unknown) => void;
    hostMetadata?: (
      params: PluginToolCallParams,
      signal: AbortSignal,
    ) => Promise<Record<string, unknown>>;
  },
): Promise<Response> {
  const { actor, owner, admission, runtime, resolve, assertOrigin, origin } =
    input;
  const params = sanitizePluginToolParams(input.params);
  const combinedAdmission = pluginResolverIncludesAdmission(resolve);
  const approvalBinding = {
    subject: actor.subject,
    projectId: actor.projectId,
    chatSessionId: `plugin-instance:${owner.instanceId}:${owner.generation}`,
  };
  try {
    input.assertLive();
    const initial = await resolve(params.name, c.req.raw.signal);
    assertOrigin(initial);
    const validateResult = input.validate?.(initial);
    const approvalCall = {
      toolCallId: input.invocationId,
      toolName: params.name,
      input: { revision: initial.revision, params },
    };
    const receipts = createPluginInvocationReceiptPort(owner, actor.subject);
    const saved =
      receipts && initial.requiresApproval && !input.approval && !input.resume
        ? await receipts.read(input.invocationId, c.req.raw.signal)
        : undefined;
    if (
      initial.requiresApproval &&
      !input.approval &&
      !input.resume &&
      !saved
    ) {
      const id = mintToolApprovalId({
        binding: approvalBinding,
        call: approvalCall,
      });
      if (!id) throw new PluginInvocationError("APPROVAL_UNAVAILABLE");
      return c.json(
        {
          status: "approval_required",
          approval: {
            id,
            invocationId: input.invocationId,
            name: params.name,
            params,
          },
        },
        409,
      );
    }
    const authorize = async (
      ...[requestedOwner, requestedOrigin, next, signal, read]: [
        ...Parameters<PluginInvocationPorts["authorize"]>,
        PluginInstanceAdmissionRead?,
      ]
    ) => {
      input.assertLive();
      if (
        requestedOrigin !== origin ||
        requestedOwner.instanceId !== owner.instanceId
      )
        throw new PluginInvocationError("INSTANCE_DENIED");
      const live = await resolve(next.name, signal, read);
      assertOrigin(live);
      return {
        owner: requestedOwner,
        revision: live.revision,
        enabled: true,
        tool: live.tool,
        allowedOrigins: [origin],
        requiresApproval: live.requiresApproval,
      };
    };
    const ports: PluginInstanceInvocationPorts = {
      receipts,
      ...(input.resume
        ? {
            continuation: {
              submission: input.resume,
              resume: async (
                authorization: import("./invocation.js").ResolvedInvocationContext,
                next: PluginToolCallParams,
                signal: AbortSignal,
              ) => {
                if (!runtime.resumeMrtr)
                  throw new PluginInvocationError(
                    "CONTINUATION_PROTOCOL_DENIED",
                  );
                return runtime.resumeMrtr(
                  authorization,
                  input.invocationId,
                  next,
                  input.resume!,
                  signal,
                );
              },
            },
          }
        : {}),
      authorize,
      authorizeInstance: authorize,
      approve: async (authorization) => {
        if (
          !input.approval?.approved ||
          authorization.revision !== initial.revision
        )
          return false;
        if (
          !verifyToolApprovalId({
            approvalId: input.approval.id,
            binding: approvalBinding,
            call: approvalCall,
          }).ok
        )
          return false;
        return (await claimToolApproval(input.approval.id)) === "claimed";
      },
      // MCP operations reuse member admission; model billing stays on the chat turn.
      admit: combinedAdmission
        ? createPluginAdmissionNoop()
        : async (_authorization, _id, signal) => {
            signal.throwIfAborted();
            await admission.revalidate({ signal });
          },
      execute: async (authorization, next, signal) => {
        const metadata = input.hostMetadata
          ? await input.hostMetadata(next, signal)
          : next._meta;
        signal.throwIfAborted();
        const manager = runtime.manager();
        if (!manager)
          throw new PluginInvocationError("INSTANCE_CONNECTION_UNAVAILABLE");
        captureServerEvent(c, "execute_tool_server", {
          tool_name: next.name,
          server_id: owner.serverId,
        });
        const result = await timedPluginStep("tool-call", async () =>
          runtime.executeOwned
            ? await runtime.executeOwned(
                authorization,
                input.invocationId,
                { ...next, _meta: metadata },
                signal,
              )
            : await manager.executeTool(
                owner.serverId,
                next.name,
                next.arguments ?? {},
                {
                  metadata,
                  request: { signal },
                  retry: { retries: 0, retryDelayMs: 0 },
                },
              ),
        );
        if (!(result instanceof PluginInvocationSuspension))
          validateResult?.(result);
        return result;
      },
      classifyFailure: classifyPluginToolFailure,
    };
    let result: unknown;
    try {
      result = await input.invoke(ports, params);
    } catch (error) {
      // The server answered with a JSON-RPC error: a known failure, described
      // for the caller instead of surfacing as an internal error.
      if (
        !(error instanceof PluginInvocationError) &&
        classifyPluginToolFailure(error) === "failed"
      )
        throw new PluginToolCallFailure(error);
      throw error;
    }
    // Duplicate delivery still requires this request's current actor and authority.
    try {
      if (!combinedAdmission)
        await admission.revalidate({ signal: c.req.raw.signal });
      input.assertLive();
      const delivery = await resolve(params.name, c.req.raw.signal);
      assertOrigin(delivery);
      if (delivery.revision !== initial.revision)
        throw new PluginInvocationError("INSTANCE_DENIED");
    } catch (error) {
      // invoke has already returned a known result or a durable suspension.
      // A fresh delivery refusal cannot turn that accepted receipt into an
      // uncertain effect, and must never invite a replacement execution.
      if (error instanceof PluginInvocationError) throw error;
      throw new PluginInvocationError("INSTANCE_DELIVERY_DENIED");
    }
    // Logs entries this request owes the client (a form that ended because
    // a toggle changed while it was pending), beside the result.
    const notes = runtime.diagnostics?.() ?? [];
    const logged = notes.length ? { diagnostics: notes } : {};
    return result instanceof PluginInvocationSuspension
      ? c.json({ ...result.pending, ...logged })
      : c.json({ status: "completed", result, ...logged });
  } catch (error) {
    const notes = runtime.diagnostics?.() ?? [];
    if (error instanceof PluginInvocationError && notes.length)
      error.diagnostics = [...notes, ...(error.diagnostics ?? [])];
    throw error;
  } finally {
    await runtime.release();
  }
}
