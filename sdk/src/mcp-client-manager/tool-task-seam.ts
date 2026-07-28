/**
 * The single place a model-facing tool call may become a task.
 *
 * ## Why this is one seam and not per-surface wiring
 *
 * Chat, the agent and evals all reach their tools through the `callTool`
 * closure `getToolsForAiSdk` builds. Putting the task decision there means the
 * per-server wire is already in scope (the closure captures its own server id),
 * so a tool set spanning an extension server, a 2025-11-25 server and a
 * 2025-06-18 server does the right thing per call without any surface knowing
 * that mixed sets exist. A set-level decision is not merely discouraged here —
 * it is unrepresentable.
 *
 * ## Three invariants
 *
 *  1. **No task option ⇒ byte-identical requests.** The manager does not call
 *     this module at all when the caller passed no `tasks` option, and
 *     {@link toolTaskSeamOptionsFor} returns `undefined` for mode `off`. There
 *     is exactly one no-tasks path and it is the one that existed before this
 *     file.
 *  2. **Extension wire only.** The legacy (2025-11-25) wire opts in with
 *     `task: {ttl}` per call and stays a Tools-tab affordance; letting a host
 *     policy create legacy tasks would change behavior for every existing chat
 *     against a 2025-11-25 server. On any non-extension wire this delegates to
 *     the caller's plain call, unchanged.
 *  3. **A created task is never lost.** The fan-out fires before anything that
 *     can fail, and a functional consumer's throw is converted into an error
 *     *result carrying the handle* rather than an exception. See
 *     {@link runToolTaskSeam}.
 */

import type { CallToolResult } from "@modelcontextprotocol/client";
import type { TaskMode } from "../host-config/tasks-policy.js";
import type { TasksWire } from "./tasks-dispatch.js";
import {
  assertCallToolResult,
  isCallToolResult,
} from "./result-guards.js";
import { isCreateTaskExtResult, assertCreateTaskExtResult } from "./tasks-ext-guards.js";
import type {
  TaskCreatedEvent,
  TaskCreationSurface,
} from "./task-created-event.js";
import type {
  TaskLifecycleIdentity,
  TaskLifecycleObservation,
  TaskLifecycleSnapshot,
} from "./task-lifecycle.js";
import { TaskLifecycleEngine } from "./task-lifecycle.js";
import {
  driveTaskToTerminal,
  type TaskAwaitOutcome,
  type TaskAwaitResult,
} from "./task-await-driver.js";
import type { TaskInputDriverOptions } from "./task-input-driver.js";

/**
 * `_meta` key carrying the task handle on every result this seam synthesizes.
 *
 * Namespaced under `com.mcpjam/` for the same reason the host policy is: it is
 * MCPJam's own annotation on a result, not anything SEP-2663 defines, and it
 * must never be mistaken for server-authored wire data.
 */
export const TASK_SEAM_META_KEY = "com.mcpjam/task" as const;

/** Shape stored at {@link TASK_SEAM_META_KEY}. */
export interface ToolTaskSeamMeta {
  taskId: string;
  serverId: string;
  wire: "extension";
  status?: string;
  createdAt?: string;
  ttlMs?: number | null;
  pollIntervalMs?: number;
  /** How the drive ended. `await` mode only. */
  outcome?: TaskAwaitOutcome;
  /**
   * Set when a server sent a human-readable string for the model alongside the
   * task handle. SEP-2663 defines no such field, so the value is recorded here
   * and NEVER used as the model-facing text — see
   * {@link synthesizeCreatedTaskResult}.
   */
  textSource?: "server-legacy";
  /** The off-spec server text itself, when there was one. */
  serverText?: string;
}

/** What the manager supplies for one tool call. */
export interface ToolTaskSeamContext {
  serverId: string;
  toolName: string;
  /** Resolved per server, so mixed-wire tool sets work by construction. */
  wire: TasksWire;
  /** The pre-existing call, verbatim. Used on every non-task path. */
  callPlain: () => Promise<unknown>;
  /** A call that declares task eligibility. Extension wire only. */
  callEligible: () => Promise<unknown>;
  /** Reads task state. Required for `await`, unused by `expose`. */
  getTask?: (taskId: string) => Promise<TaskLifecycleObservation>;
  /** Submits input responses. `await` mode only. */
  updateTask?: (
    taskId: string,
    inputResponses: Record<string, unknown>
  ) => Promise<void>;
}

/** Tuning for `await` mode. Every field is optional; the driver has defaults. */
export interface ToolTaskAwaitOptions {
  timeoutMs?: number;
  maxConsecutiveErrors?: number;
  maxInputRounds?: number;
  /** Answers `input_required` rounds. Absent ⇒ any input ends the drive. */
  input?: TaskInputDriverOptions;
  /** Share the surface's engine so an await drive respects live poll floors. */
  engine?: TaskLifecycleEngine;
  signal?: AbortSignal;
}

export interface ToolTaskSeamOptions {
  /**
   * `off` is deliberately not representable. {@link toolTaskSeamOptionsFor}
   * returns `undefined` for it, which is what keeps "tasks disabled" and "no
   * tasks option" the same single code path.
   */
  mode: Exclude<TaskMode, "off">;
  surface: TaskCreationSurface;
  /** Auth/org context (hosted `projectId`), carried into the task identity. */
  scope?: string;
  /**
   * The fan-out. Fired before the result is synthesized and, in `await` mode,
   * before the drive starts.
   */
  onTaskCreated: (event: TaskCreatedEvent) => void | Promise<void>;
  await?: ToolTaskAwaitOptions;
}

/**
 * Resolves a surface's mode into seam options, or `undefined` for `off`.
 *
 * The mode is resolved by the CALLER and passed in. This module must not read
 * a host config: `mcp-client-manager` has no business knowing what a host is,
 * and `conformance` / `api` are caller-owned surfaces that must be able to
 * resolve a mode and still deliberately pass nothing.
 */
export function toolTaskSeamOptionsFor(
  mode: TaskMode,
  rest: Omit<ToolTaskSeamOptions, "mode">
): ToolTaskSeamOptions | undefined {
  if (mode === "off") return undefined;
  return { mode, ...rest };
}

function metaFor(
  meta: ToolTaskSeamMeta
): Record<string, unknown> {
  return { [TASK_SEAM_META_KEY]: meta };
}

/**
 * Builds a valid `CallToolResult` announcing a created task.
 *
 * The text is MCPJam's, not the server's. SEP-2663 has no
 * "model-immediate-response" concept, so there is no server-authored string
 * this seam is entitled to hand the model — a server that sends one anyway is
 * off-spec, and rendering it would let an untrusted server inject text into
 * the conversation through a field no specification blesses. The value is kept
 * in `_meta` (labelled `textSource: "server-legacy"`) so the debugger can show
 * what was actually sent, and dropped from the model's view.
 */
function synthesizeCreatedTaskResult(
  meta: ToolTaskSeamMeta,
  text: string,
  isError = false
): CallToolResult {
  return {
    content: [{ type: "text", text }],
    ...(isError ? { isError: true } : {}),
    _meta: metaFor(meta),
  } as CallToolResult;
}

/**
 * The 2025-11-25 key for "text to give the model while the task runs".
 *
 * It belongs to the LEGACY wire — SEP-2663 has no equivalent — so finding it on
 * an extension-wire create result means the server sent something the
 * extension does not define.
 */
const LEGACY_MODEL_IMMEDIATE_RESPONSE_KEY =
  "io.modelcontextprotocol/model-immediate-response";

/**
 * Reads the off-spec "text for the model" field, if the server sent one.
 *
 * Checked purely so it can be preserved and labelled; never used as output.
 */
function readServerLegacyText(result: unknown): string | undefined {
  const meta = (result as { _meta?: Record<string, unknown> } | null | undefined)
    ?._meta;
  const candidate = meta?.[LEGACY_MODEL_IMMEDIATE_RESPONSE_KEY];
  return typeof candidate === "string" && candidate.length > 0
    ? candidate
    : undefined;
}

/**
 * Runs one tool call under a task policy.
 *
 * @returns always a valid `CallToolResult` — every synthesized result is built
 * to pass `assertCallToolResult`, which the manager applies to this return
 * value and `tool-converters` applies again inside `execute`.
 */
export async function runToolTaskSeam(
  context: ToolTaskSeamContext,
  options: ToolTaskSeamOptions
): Promise<CallToolResult> {
  // Not an extension server: the pre-existing call, unchanged. This is the
  // guard that keeps a chat turn touching a 2025-06-18 server from reaching
  // `withTaskEligibilityDeclaration`, which throws on `wire: "none"`.
  if (context.wire !== "extension") {
    const plain = await context.callPlain();
    return assertCallToolResult(plain, `Tool "${context.toolName}" result`);
  }

  const raw = await context.callEligible();

  // The server decides. A plain result from a task-eligible call is entirely
  // valid and is returned exactly as an unwired call would return it.
  if (!isCreateTaskExtResult(raw)) {
    return assertCallToolResult(raw, `Tool "${context.toolName}" result`);
  }

  // Validated, not merely sniffed: everything below reads `taskId` and status
  // fields off this payload, and an unvalidated handle is one that gets
  // tracked, persisted, and polled forever.
  const created = assertCreateTaskExtResult(
    raw,
    `Tool "${context.toolName}" task result`
  );

  const identity: TaskLifecycleIdentity = {
    ...(options.scope !== undefined ? { scope: options.scope } : {}),
    serverId: context.serverId,
    wire: "extension",
    taskId: created.taskId,
  };

  const serverText = readServerLegacyText(raw);
  const baseMeta: ToolTaskSeamMeta = {
    taskId: created.taskId,
    serverId: context.serverId,
    wire: "extension",
    status: created.status,
    createdAt: created.createdAt,
    ttlMs: created.ttlMs,
    ...(created.pollIntervalMs !== undefined
      ? { pollIntervalMs: created.pollIntervalMs }
      : {}),
    ...(serverText !== undefined
      ? { textSource: "server-legacy" as const, serverText }
      : {}),
  };

  const event: TaskCreatedEvent = {
    identity,
    wire: "extension",
    surface: options.surface,
    createdAt: created.createdAt,
    ttlMs: created.ttlMs,
    ...(created.pollIntervalMs !== undefined
      ? { pollIntervalMs: created.pollIntervalMs }
      : {}),
    toolName: context.toolName,
    status: created.status,
  };

  // Fired FIRST, before the drive and before any result is built: a crash
  // anywhere downstream must still leave a recoverable handle behind.
  try {
    await options.onTaskCreated(event);
  } catch (error) {
    // Deliberately NOT rethrown. A throw here fails `execute`, which skips
    // `MCP_PRESERVE_RAW_RESULT_FOR_UI` and loses the `taskId` entirely — the
    // exact "task created from chat ends up untracked" failure the sink exists
    // to prevent, reached through the sink itself. The handle travels in
    // `_meta` so the UI can still track and poll it.
    return synthesizeCreatedTaskResult(
      baseMeta,
      `Tool "${context.toolName}" created task ${created.taskId} on server "${context.serverId}", but recording it failed: ${describeError(error)}. The task is running; it may not appear in the task list.`,
      true
    );
  }

  if (options.mode === "expose") {
    return synthesizeCreatedTaskResult(
      baseMeta,
      `Tool "${context.toolName}" started task ${created.taskId} (status: ${created.status}). The result is not ready yet; check the task's status to retrieve it.`
    );
  }

  return driveCreatedTask(context, options, identity, baseMeta, created.taskId);
}

/**
 * `await` mode: block until the task reaches a terminal state or a bounded
 * exit, then map that outcome onto a tool result.
 */
async function driveCreatedTask(
  context: ToolTaskSeamContext,
  options: ToolTaskSeamOptions,
  identity: TaskLifecycleIdentity,
  baseMeta: ToolTaskSeamMeta,
  taskId: string
): Promise<CallToolResult> {
  const getTask = context.getTask;
  if (!getTask) {
    // A caller that asks for `await` without giving the seam a way to read the
    // task has a wiring bug, not a runtime condition. Reported as a result
    // rather than a throw so the handle still reaches the UI.
    return synthesizeCreatedTaskResult(
      { ...baseMeta, outcome: "unreachable" },
      `Task ${taskId} was created but this surface cannot read task state, so it could not be awaited.`,
      true
    );
  }

  const tuning = options.await ?? {};
  const result: TaskAwaitResult = await driveTaskToTerminal({
    identity,
    getTask: (id) => getTask(id.taskId),
    ...(context.updateTask
      ? {
          updateTask: (id, inputResponses) =>
            context.updateTask!(id.taskId, inputResponses),
        }
      : {}),
    ...(tuning.input ? { input: tuning.input } : {}),
    ...(tuning.timeoutMs !== undefined ? { timeoutMs: tuning.timeoutMs } : {}),
    ...(tuning.maxConsecutiveErrors !== undefined
      ? { maxConsecutiveErrors: tuning.maxConsecutiveErrors }
      : {}),
    ...(tuning.maxInputRounds !== undefined
      ? { maxInputRounds: tuning.maxInputRounds }
      : {}),
    ...(tuning.engine ? { engine: tuning.engine } : {}),
    ...(tuning.signal ? { signal: tuning.signal } : {}),
  });

  const meta: ToolTaskSeamMeta = {
    ...baseMeta,
    outcome: result.outcome,
    ...(result.task?.status ? { status: result.task.status } : {}),
  };

  // No `default`. Every outcome is named, so adding a ninth to
  // `TaskAwaitOutcome` is a compile error here rather than a silent fallthrough
  // that reports someone else's failure mode.
  switch (result.outcome) {
    case "completed":
      return completedTaskResult(context, meta, taskId, result);
    case "failed":
      return synthesizeCreatedTaskResult(
        meta,
        `Task ${taskId} failed: ${describeTaskError(result)}`,
        true
      );
    case "cancelled":
      return synthesizeCreatedTaskResult(
        meta,
        `Task ${taskId} was cancelled before it produced a result.`,
        true
      );
    case "expired":
      return synthesizeCreatedTaskResult(
        meta,
        `Task ${taskId} expired: server "${context.serverId}" no longer recognizes the handle.`,
        true
      );
    case "input-required":
      return synthesizeCreatedTaskResult(
        meta,
        `Task ${taskId} needs input that this surface cannot supply${describeUnanswered(result)}.`,
        true
      );
    case "timeout":
      return synthesizeCreatedTaskResult(
        meta,
        `Task ${taskId} did not finish within the time allowed; it may still be running on the server.`,
        true
      );
    case "aborted":
      return synthesizeCreatedTaskResult(
        meta,
        `Waiting for task ${taskId} was aborted; it may still be running on the server.`,
        true
      );
    case "unreachable":
      return synthesizeCreatedTaskResult(
        meta,
        `Task ${taskId} could not be read from server "${context.serverId}": ${describeError(result.lastError)}`,
        true
      );
  }
}

/**
 * A completed task returns the tool's own result, verbatim — including its own
 * `isError`.
 *
 * A tool that reports failure through `isError: true` ran to completion and
 * said so; that is a *completed* task carrying a tool error, categorically
 * different from a `failed` task (a JSON-RPC fault). Rewriting it here would
 * tell the model the task machinery broke when the tool simply returned an
 * error, and would discard the tool's own explanation.
 */
function completedTaskResult(
  context: ToolTaskSeamContext,
  meta: ToolTaskSeamMeta,
  taskId: string,
  result: TaskAwaitResult
): CallToolResult {
  const payload = result.task?.result;
  if (isCallToolResult(payload)) {
    return {
      ...payload,
      _meta: { ...(payload._meta ?? {}), ...metaFor(meta) },
    } as CallToolResult;
  }
  // Completed with no readable payload. The task genuinely finished, so this
  // is not an `isError` for the task machinery's sake — but the model asked for
  // output and there is none, so it must be told rather than handed an empty
  // result that reads as success with nothing to say.
  return synthesizeCreatedTaskResult(
    meta,
    `Task ${taskId} on server "${context.serverId}" completed, but its result could not be read${
      result.lastError ? `: ${describeError(result.lastError)}` : "."
    }`,
    true
  );
}

function describeUnanswered(result: TaskAwaitResult): string {
  const keys = result.unansweredInput
    ?.map((entry) => entry.inputKey)
    .filter(Boolean);
  return keys && keys.length > 0 ? ` (unanswered: ${keys.join(", ")})` : "";
}

function describeTaskError(result: TaskAwaitResult): string {
  const snapshot: TaskLifecycleSnapshot | undefined = result.task;
  const message = snapshot?.error?.message;
  if (typeof message === "string" && message.length > 0) return message;
  return snapshot?.statusMessage ?? "no error detail was reported";
}

function describeError(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (typeof error === "string") return error;
  return String(error);
}
