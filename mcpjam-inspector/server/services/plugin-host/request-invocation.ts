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
    /** The owner's fenced reads for the first resolution (a retained App's
     * `pluginInstances.fence`). With it, the first resolution makes exactly
     * the reads of an invoker authorization, and the invoker's first
     * authorization reuses it; `invoke` must hand the same fence on. */
    firstRead?: PluginInstanceAdmissionRead;
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
  const deferred: (() => Promise<void>)[] = [];
  try {
    input.assertLive();
    const initial = await resolve(
      params.name,
      c.req.raw.signal,
      input.firstRead,
    );
    assertOrigin(initial);
    // The invoker's first authorization comes next with nothing awaited in
    // between, so it may stand on this fenced resolution instead of making
    // the same reads again. Any await below drops it.
    let primed = input.firstRead
      ? { name: params.name, resolved: initial }
      : undefined;
    const validateResult = input.validate?.(initial);
    const approvalCall = {
      toolCallId: input.invocationId,
      toolName: params.name,
      input: { revision: initial.revision, params },
    };
    const receipts = createPluginInvocationReceiptPort(owner, actor.subject);
    let saved = false;
    if (
      receipts &&
      initial.requiresApproval &&
      !input.approval &&
      !input.resume
    ) {
      primed = undefined;
      saved = !!(await receipts.read(input.invocationId, c.req.raw.signal));
    }
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
    // The invoker's latest authorization that read current state, while
    // nothing else has run since (no receipt write, approval, admission,
    // metadata or tool call). The invoker always ends with such an
    // authorization (after the effect, or around a replayed result), so the
    // delivery check below stands on it instead of reading again.
    let latest: { name: string; resolved: Resolved } | undefined;
    const ran = () => {
      primed = undefined;
      latest = undefined;
    };
    const authorize = async (
      ...[requestedOwner, requestedOrigin, next, signal, read]: [
        ...Parameters<PluginInvocationPorts["authorize"]>,
        PluginInstanceAdmissionRead?,
      ]
    ) => {
      latest = undefined;
      input.assertLive();
      if (
        requestedOrigin !== origin ||
        requestedOwner.instanceId !== owner.instanceId
      )
        throw new PluginInvocationError("INSTANCE_DENIED");
      const reuse =
        primed && read && next.name === primed.name
          ? primed.resolved
          : undefined;
      primed = undefined;
      const live = reuse ?? (await resolve(next.name, signal, read));
      assertOrigin(live);
      if (!reuse) latest = { name: next.name, resolved: live };
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
      // A receipt read before the first authorization (recovering an evicted
      // or suspended call) is an await: the first authorization reads again.
      receipts: receipts && {
        read: (...args) => {
          ran();
          return receipts.read(...args);
        },
        claim: (...args) => {
          ran();
          return receipts.claim(...args);
        },
        write: (...args) => {
          ran();
          return receipts.write(...args);
        },
      },
      ...(input.resume
        ? {
            continuation: {
              submission: input.resume,
              resume: async (
                authorization: import("./invocation.js").ResolvedInvocationContext,
                next: PluginToolCallParams,
                signal: AbortSignal,
              ) => {
                ran();
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
        ran();
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
            ran();
            signal.throwIfAborted();
            await admission.revalidate({ signal });
          },
      execute: async (authorization, next, signal) => {
        ran();
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
      defer: (work) => {
        deferred.push(work);
      },
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
    // Duplicate delivery still requires this request's current actor and
    // authority. When the invoker's last step was a full authorization of
    // this tool (admission included) and nothing ran after it, delivery
    // stands on that read: it was taken after the effect, with no write or
    // wait since. Otherwise it reads again.
    try {
      const settled =
        combinedAdmission && latest?.name === params.name
          ? latest.resolved
          : undefined;
      if (!settled && !combinedAdmission)
        await admission.revalidate({ signal: c.req.raw.signal });
      input.assertLive();
      const delivery =
        settled ?? (await resolve(params.name, c.req.raw.signal));
      input.assertLive();
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
    // Records that no longer gate the answer (see `PluginInvocationPorts.defer`).
    for (const work of deferred.splice(0)) void work().catch(() => {});
  }
}
