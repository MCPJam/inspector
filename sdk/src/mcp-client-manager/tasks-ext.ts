/**
 * `io.modelcontextprotocol/tasks` (SEP-2663) client operations.
 *
 * The extension is server-decided: a client never asks for a task, it declares
 * per request that it is *eligible* to receive one. That declaration rides in
 * `params._meta["io.modelcontextprotocol/clientCapabilities"]` and MUST be
 * present on every extension operation — the `tools/call` that may produce a
 * task AND the subsequent `tasks/get` / `tasks/update` / `tasks/cancel`
 * (`-32021` otherwise).
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
 * 2. the outbound era gate — solved by `tasks-ext-era-gate.ts`, which is where
 *    the reasoning lives. Its shadow is installed LAZILY, from
 *    {@link sendTasksExtRequest} below: it probes a private upstream member,
 *    so it must not sit on the connect path of servers that never speak this
 *    extension.
 */

import { CLIENT_CAPABILITIES_META_KEY } from "@modelcontextprotocol/client";
import { z } from "zod";
import { mergeClientCapabilities } from "./capabilities.js";
import { ensureTasksExtensionEraGateShadow } from "./tasks-ext-era-gate.js";
import {
  resolveListenMetaTarget,
  withTasksExtensionEnvelope,
} from "./tasks-ext-listen-meta.js";
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

/**
 * The send path for the extension: all three request helpers below build their
 * params and then come through here, and every DECLARED extension request in
 * the SDK does.
 *
 * One deliberate exception: the tasks conformance runner
 * (`tasks-conformance/`) issues its UNDECLARED probes directly, bypassing this
 * helper. It has to — this helper always attaches the eligibility declaration,
 * and the whole point of those probes is to observe what a server does when
 * the declaration is absent (a conforming one answers `-32021`). That bypass
 * is the test, not a bug. Being off this path, it installs the era-gate shadow
 * itself before probing (`tasks-conformance/runner.ts`), since the probes still
 * have to reach the wire on a 2026-07-28 connection to be answered at all.
 *
 * For everything else this stays the only choke point where the era-gate
 * shadow has to be installed — and, because the exemption set IS
 * `TasksExtRequestMethods`, a request that never passes through here is by
 * definition a request the shadow would not have exempted anyway.
 *
 * The install is idempotent per client instance, so the cost after the first
 * extension call is a `WeakMap`/`WeakSet` hit.
 *
 * @throws {TasksExtEraGateSeamError} when this client's upstream era-gate
 * member has moved — loud here, where the extension actually depends on it,
 * and nowhere near a connect.
 */
async function sendTasksExtRequest(
  ctx: TasksExtCallContext,
  method: TasksExtRequestMethod,
  params: Record<string, unknown>
): Promise<unknown> {
  ensureTasksExtensionEraGateShadow(ctx.client);
  return ctx.client.requestWithSchema(
    {
      method,
      params: withTasksExtensionDeclaration(params, ctx.declaredCapabilities),
    },
    TASKS_EXT_WIRE_RESULT_SCHEMA,
    ctx.options
  );
}

/**
 * Opens a task-filtered `subscriptions/listen` carrying the extension's
 * eligibility declaration.
 *
 * The declaration is mandatory on this request too — a non-declaring client
 * MUST get `-32021` (`tasks.md:797-799`) — but `Client.listen` builds its own
 * `params._meta` and takes no caller `_meta`. `tasks-ext-listen-meta.ts`
 * explains the seam and why it is scoped to this one call.
 *
 * Returns `undefined` when this connection cannot listen at all, or cannot
 * declare on the listen. Both are the same outcome for the caller: **do not
 * send a task-filtered listen**, keep polling. Task notifications are OPTIONAL
 * in the extension, so nothing is lost but latency.
 *
 * @throws {TasksExtListenMetaSeamError} when the upstream seam has moved. Loud
 * on purpose: a silent fallback would hide a client bump that broke the
 * declaration, and the caller can catch it to degrade to polling deliberately.
 */
/**
 * Whether {@link openTaskDeclaredListen} would have a wire to ride on this
 * client: the managed client exposes `listen`, AND an upstream `Client` with
 * the outbound-envelope seam is reachable behind it. A test double with no
 * upstream client probes false — it has no envelope to widen, so a declared
 * listen through it could never carry the declaration.
 *
 * This is the SAME availability check `openTaskDeclaredListen` performs before
 * returning `undefined`, extracted so callers that install the opener onto a
 * port (where availability is expressed by method PRESENCE, per
 * `SubscriptionClientPort.listenWithTasksDeclaration`) probe the one shared
 * predicate instead of re-deriving it.
 */
export function canOpenTaskDeclaredListen(client: ManagedMcpClient): boolean {
  return (
    typeof (client as { listen?: unknown }).listen === "function" &&
    resolveListenMetaTarget(client as unknown as object) !== undefined
  );
}

export async function openTaskDeclaredListen(
  ctx: Omit<TasksExtCallContext, "options">,
  filter: Record<string, unknown>
): Promise<unknown | undefined> {
  // One shared availability predicate with the callers that probe before
  // installing the opener onto a port — see `canOpenTaskDeclaredListen`.
  if (!canOpenTaskDeclaredListen(ctx.client)) return undefined;
  const listen = (
    ctx.client as {
      listen: (filter: unknown, options?: unknown) => Promise<unknown>;
    }
  ).listen;
  const target = resolveListenMetaTarget(ctx.client as unknown as object)!;
  return withTasksExtensionEnvelope(
    target,
    ctx.declaredCapabilities,
    () => listen.call(ctx.client, filter),
    // `listen()` resolves only once the server has ACKNOWLEDGED, so a seam
    // failure is detected with the subscription already live. The caller gets a
    // rejection and never sees this handle, so if we do not close it here the
    // server keeps the subscription — and never receives the
    // `notifications/cancelled` that `close()` sends — for the life of the
    // connection, once per attempt.
    async (handle) => {
      const close = (handle as { close?: () => Promise<void> } | undefined)
        ?.close;
      if (typeof close === "function") await close.call(handle);
    }
  );
}

/** `tasks/get` — a completed task carries its `result` INLINE. */
export async function getTaskExt(
  ctx: TasksExtCallContext,
  taskId: string
): Promise<GetTaskExtResult> {
  const raw = await sendTasksExtRequest(ctx, TasksExtGetMethod, { taskId });
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
  const raw = await sendTasksExtRequest(ctx, TasksExtUpdateMethod, {
    taskId,
    inputResponses,
  });
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
  const raw = await sendTasksExtRequest(ctx, TasksExtCancelMethod, { taskId });
  return assertTaskExtAck(raw, "tasks/cancel result", TasksExtCancelMethod);
}
