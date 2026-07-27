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
 *
 * ## Getting the three methods onto the wire at all
 *
 * Two separate upstream constructs stand between these helpers and a socket,
 * and BOTH have to be dealt with:
 *
 * 1. the result-schema seam — solved here, by sending every extension request
 *    through `requestWithSchema` (see {@link TASKS_EXT_WIRE_RESULT_SCHEMA});
 * 2. the outbound era gate — solved at connect time in
 *    `tasks-ext-era-gate.ts`, which is where the reasoning lives.
 */

import { CLIENT_CAPABILITIES_META_KEY } from "@modelcontextprotocol/client";
import { z } from "zod";
import { mergeClientCapabilities } from "./capabilities.js";
import type { ManagedMcpClient } from "./managed-mcp-client.js";
import type { ClientCapabilityOptions, ClientRequestOptions } from "./types.js";
import {
  assertGetTaskExtResult,
  assertTaskExtAck,
} from "./tasks-ext-guards.js";
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
 * The three extension REQUEST methods, as one list. Derived from the constants
 * above so it can never drift from them.
 *
 * Two consumers depend on this being exactly the extension's method set:
 * `tasks-ext-era-gate.ts` (which exempts them from the client's outbound era
 * gate) and the request helpers below. `notifications/tasks` is deliberately
 * absent — it is inbound and never era-gated on send.
 */
export const TasksExtRequestMethods = [
  TasksExtGetMethod,
  TasksExtUpdateMethod,
  TasksExtCancelMethod,
] as const;

export type TasksExtRequestMethod = (typeof TasksExtRequestMethods)[number];

/**
 * Wire-level result schema for every extension request.
 *
 * Deliberately loose, exactly like the legacy wire's
 * `LEGACY_TASKS_RESULT_SCHEMA` (`tasks.ts:20`): the real validation is the
 * zod mirror in `tasks-ext-guards.ts`, which discriminates on `status` and
 * produces `InvalidTaskExtPayloadError` with a per-field issue list. A strict
 * schema here would instead surface upstream's generic "invalid result" and
 * lose that diagnosis.
 *
 * Passing it is NOT optional. All three methods must ride the
 * explicit-result-schema overload of upstream `Protocol.request`
 * (`requestWithSchema`, see `official-sdk-client-adapter.ts:114`), because the
 * schema-less overload resolves its validator from the negotiated era's
 * registry (`codecResultValidator`) and that returns `undefined` for every
 * extension method — the call then throws "'…' is not a spec method".
 */
const TASKS_EXT_WIRE_RESULT_SCHEMA = z.looseObject({});

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
  const raw = await ctx.client.requestWithSchema(
    {
      method: TasksExtGetMethod,
      params: withTasksExtensionDeclaration(
        { taskId },
        ctx.declaredCapabilities
      ),
    },
    TASKS_EXT_WIRE_RESULT_SCHEMA,
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
  const raw = await ctx.client.requestWithSchema(
    {
      method: TasksExtUpdateMethod,
      params: withTasksExtensionDeclaration(
        { taskId, inputResponses },
        ctx.declaredCapabilities
      ),
    },
    TASKS_EXT_WIRE_RESULT_SCHEMA,
    ctx.options
  );
  // Validated as an object only: the ack carries no task state, so anything
  // that is not an object is a wire violation rather than a task to render.
  return assertTaskExtAck(raw, "tasks/update result", TasksExtUpdateMethod);
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
  const raw = await ctx.client.requestWithSchema(
    {
      method: TasksExtCancelMethod,
      params: withTasksExtensionDeclaration(
        { taskId },
        ctx.declaredCapabilities
      ),
    },
    TASKS_EXT_WIRE_RESULT_SCHEMA,
    ctx.options
  );
  return assertTaskExtAck(raw, "tasks/cancel result", TasksExtCancelMethod);
}
