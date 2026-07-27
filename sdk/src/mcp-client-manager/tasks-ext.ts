/**
 * `io.modelcontextprotocol/tasks` (SEP-2663) client operations.
 *
 * The extension is server-decided: a client never asks for a task, it declares
 * per request that it is *eligible* to receive one. That declaration rides in
 * `params._meta["io.modelcontextprotocol/clientCapabilities"]` and MUST be
 * present on every extension operation — the `tools/call` that may produce a
 * task AND the subsequent `tasks/get` / `tasks/update` / `tasks/cancel`
 * (`-32003` otherwise).
 *
 * ## The beta.4 envelope seam (investigated, PR2)
 *
 * On a modern connection beta.4 auto-attaches a complete per-request `_meta`
 * envelope — protocol version, client info, client capabilities (client
 * `dist/index.mjs:2863 _outboundMetaEnvelope`, built from the client-level
 * `this._capabilities`). `Protocol._envelopeOutbound` then merges it with the
 * caller's `_meta` **one key deep**:
 *
 * ```js
 * _meta: { ...envelope, ...params._meta }   // user keys win, per key
 * ```
 *
 * So there is NO per-request seam for *extending* the declared capabilities:
 * writing `_meta[CLIENT_CAPABILITIES_META_KEY]` replaces beta.4's whole
 * capabilities object. The only other seam, `registerCapabilities()`, is
 * connection-wide — it would declare task eligibility on every request, which
 * the spec's per-request opt-in (and the UI's per-call "Allow task response"
 * toggle) forbids.
 *
 * Therefore {@link buildTasksExtensionRequestMeta} **reconstructs the full
 * envelope value**: it merges the tasks extension into the exact
 * `ClientCapabilities` object the manager passed to `new Client(...)` (the
 * same object beta.4 copied into `_capabilities`), reusing
 * `mergeClientCapabilities`' extension-map semantics so no unrelated extension
 * entry is dropped. The protocol-version and client-info envelope keys are
 * never written here, so beta.4's auto-generated values for them survive
 * untouched. `tasks-ext.test.ts` pins the no-clobbering property.
 */

import { CLIENT_CAPABILITIES_META_KEY } from "@modelcontextprotocol/client";
import { mergeClientCapabilities } from "./capabilities.js";
import type { ManagedMcpClient } from "./managed-mcp-client.js";
import type { ClientCapabilityOptions, ClientRequestOptions } from "./types.js";
import { assertGetTaskExtResult } from "./tasks-ext-guards.js";
import type {
  CancelTaskExtResult,
  GetTaskExtResult,
  InputResponses,
  UpdateTaskExtResult,
} from "./tasks-ext-types.js";

export { MCP_TASKS_EXTENSION_ID } from "./tasks-dispatch.js";
export { CLIENT_CAPABILITIES_META_KEY };

import { MCP_TASKS_EXTENSION_ID } from "./tasks-dispatch.js";

/** The extension methods (there is no `tasks/list` and no `tasks/result`). */
export const TasksExtGetMethod = "tasks/get" as const;
export const TasksExtUpdateMethod = "tasks/update" as const;
export const TasksExtCancelMethod = "tasks/cancel" as const;
/** Optional server→client task notification (delivered via `subscriptions/listen`). */
export const TasksExtNotificationMethod = "notifications/tasks" as const;

/**
 * The `_meta` fragment declaring task eligibility for ONE request. Merges the
 * extension into `declaredCapabilities` (the client-level capabilities beta.4
 * would have auto-attached) rather than replacing them — see the module
 * comment.
 */
export function buildTasksExtensionRequestMeta(
  declaredCapabilities: ClientCapabilityOptions | undefined
): Record<string, unknown> {
  const merged = mergeClientCapabilities(declaredCapabilities, {
    extensions: { [MCP_TASKS_EXTENSION_ID]: {} },
  } as ClientCapabilityOptions);
  return { [CLIENT_CAPABILITIES_META_KEY]: merged };
}

/**
 * Spreads the declaration into a request's params, preserving any `_meta` the
 * caller already set (other than the capabilities key, which this owns).
 */
export function withTasksExtensionDeclaration<
  T extends Record<string, unknown>,
>(params: T, declaredCapabilities: ClientCapabilityOptions | undefined): T {
  const existingMeta = (params._meta ?? {}) as Record<string, unknown>;
  return {
    ...params,
    _meta: {
      ...existingMeta,
      ...buildTasksExtensionRequestMeta(declaredCapabilities),
    },
  };
}

export interface TasksExtCallContext {
  client: ManagedMcpClient;
  declaredCapabilities: ClientCapabilityOptions | undefined;
  options?: ClientRequestOptions;
}

/** `tasks/get` — a completed task carries its `result` INLINE. */
export async function getTaskExt(
  ctx: TasksExtCallContext,
  taskId: string
): Promise<GetTaskExtResult> {
  const raw = await ctx.client.request(
    {
      method: TasksExtGetMethod,
      params: withTasksExtensionDeclaration(
        { taskId },
        ctx.declaredCapabilities
      ),
    },
    ctx.options
  );
  return assertGetTaskExtResult(raw);
}

/**
 * `tasks/update` — submit (possibly partial) `inputResponses` for a task. The
 * result is an EMPTY, eventually-consistent acknowledgement (`UpdateTaskResult
 * = Result`), so it must not be validated as a task; re-poll `tasks/get`.
 */
export async function updateTaskExt(
  ctx: TasksExtCallContext,
  taskId: string,
  inputResponses: InputResponses
): Promise<UpdateTaskExtResult> {
  const raw = await ctx.client.request<UpdateTaskExtResult>(
    {
      method: TasksExtUpdateMethod,
      params: withTasksExtensionDeclaration(
        { taskId, inputResponses },
        ctx.declaredCapabilities
      ),
    },
    ctx.options
  );
  return raw ?? {};
}

/**
 * `tasks/cancel` — an EMPTY acknowledgement. Cancellation is cooperative: the
 * ack says the request was accepted, nothing about the task's fate. Callers
 * must re-poll rather than render this as a state.
 */
export async function cancelTaskExt(
  ctx: TasksExtCallContext,
  taskId: string
): Promise<CancelTaskExtResult> {
  const raw = await ctx.client.request<CancelTaskExtResult>(
    {
      method: TasksExtCancelMethod,
      params: withTasksExtensionDeclaration(
        { taskId },
        ctx.declaredCapabilities
      ),
    },
    ctx.options
  );
  return raw ?? {};
}
