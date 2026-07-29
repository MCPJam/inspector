/**
 * Shared task route handlers for the local (`/api/mcp/tasks`) and hosted
 * (`/api/web/tasks`) route sets.
 *
 * Both surfaces speak the same two wires (2025-11-25 in-core "legacy" and the
 * io.modelcontextprotocol/tasks extension), so the wire dispatch lives here
 * once. The difference between the surfaces is only how the manager is
 * obtained: local reuses a long-lived manager, hosted builds an ephemeral one
 * per request (authorize → connect → request → disconnect).
 *
 * Progress endpoints are deliberately NOT here: they depend on a
 * notification stream that a reconnect-per-poll connection cannot have, so
 * they stay local-only.
 */

import type { MCPClientManager } from "@mcpjam/sdk";
import { isCreateTaskExtResult, isUnknownTaskError } from "@mcpjam/sdk";

type Manager = InstanceType<typeof MCPClientManager>;

export const TASK_UNKNOWN_OR_EXPIRED = "task-unknown-or-expired";

/**
 * JSON-RPC -32602 on a task read means the server no longer knows the task
 * (expired, purged after cancellation, or forgotten with the session).
 *
 * Re-exported from the SDK rather than reimplemented. The local copy read only
 * `error.code`, while the SDK's also unwraps a nested `error.error.code` — so a
 * wrapped JSON-RPC error was a dead handle to the `await` driver and a live one
 * to these routes. Two answers to "is this handle gone?" is one too many.
 */
export { isUnknownTaskError };

/**
 * A tasks request the connection cannot serve — no tasks wire, a method that
 * does not exist on the resolved wire, or an undeclared capability. It is a
 * client/feature error (400), not an internal failure (500).
 */
export class TasksFeatureError extends Error {
  readonly code = "tasks-unsupported";
  readonly status = 400 as const;
  constructor(
    message: string,
    readonly wire: string,
  ) {
    super(message);
    this.name = "TasksFeatureError";
  }
}

export class UnknownTaskError extends Error {
  readonly code = TASK_UNKNOWN_OR_EXPIRED;
  constructor(
    message: string,
    readonly wire: string,
  ) {
    super(message);
    this.name = "UnknownTaskError";
  }
}

function rethrowUnknownTask(error: unknown, wire: string): never {
  if (isUnknownTaskError(error)) {
    throw new UnknownTaskError(
      error instanceof Error ? error.message : "Task unknown or expired",
      wire,
    );
  }
  throw error;
}

export function getTasksSupport(manager: Manager, serverId: string) {
  return manager.getTasksSupport(serverId);
}

export async function listTasksForWire(
  manager: Manager,
  params: { serverId: string; cursor?: string },
) {
  const support = manager.getTasksSupport(params.serverId);
  // The extension has no tasks/list: the client-side tracker is the list.
  if (!support.list) return { tasks: [], wire: support.wire };

  const result = await manager.listTasks(params.serverId, params.cursor);
  return { ...result, wire: support.wire };
}

export async function getTaskForWire(
  manager: Manager,
  params: { serverId: string; taskId: string },
) {
  const support = manager.getTasksSupport(params.serverId);
  if (support.wire === "none") {
    throw new TasksFeatureError("Server has no tasks wire", support.wire);
  }

  try {
    const task =
      support.wire === "extension"
        ? await manager.getTaskExt(params.serverId, params.taskId)
        : await manager.getTask(params.serverId, params.taskId);
    return { wire: support.wire, task };
  } catch (error) {
    rethrowUnknownTask(error, support.wire);
  }
}

/** Batch read used by hosted polling: one connection per server per tick. */
export async function getTasksBatchForWire(
  manager: Manager,
  params: { serverId: string; taskIds: string[] },
) {
  const support = manager.getTasksSupport(params.serverId);
  if (support.wire === "none") {
    throw new TasksFeatureError("Server has no tasks wire", support.wire);
  }

  const tasks: Array<{
    taskId: string;
    task?: unknown;
    error?: string;
    code?: string;
  }> = [];

  for (const taskId of params.taskIds) {
    try {
      const task =
        support.wire === "extension"
          ? await manager.getTaskExt(params.serverId, taskId)
          : await manager.getTask(params.serverId, taskId);
      tasks.push({ taskId, task });
    } catch (error) {
      if (isUnknownTaskError(error)) {
        // One forgotten task must not fail the whole tick.
        tasks.push({
          taskId,
          error: error instanceof Error ? error.message : "Unknown task",
          code: TASK_UNKNOWN_OR_EXPIRED,
        });
        continue;
      }
      throw error;
    }
  }

  return { wire: support.wire, tasks };
}

export async function getTaskResultForWire(
  manager: Manager,
  params: { serverId: string; taskId: string },
) {
  const support = manager.getTasksSupport(params.serverId);
  if (support.wire !== "legacy") {
    throw new TasksFeatureError(
      "tasks/result exists only on the 2025-11-25 wire; use tasks/get (the result is inline)",
      support.wire,
    );
  }

  const result = (await manager.getTaskResult(
    params.serverId,
    params.taskId,
  )) as Record<string, unknown> | null;

  if (result && typeof result === "object") {
    if (!result._meta) result._meta = {};
    (result._meta as Record<string, unknown>)[
      "io.modelcontextprotocol/related-task"
    ] = { taskId: params.taskId };
  }

  return result;
}

export async function updateTaskForWire(
  manager: Manager,
  params: {
    serverId: string;
    taskId: string;
    inputResponses: Record<string, unknown>;
  },
) {
  const support = manager.getTasksSupport(params.serverId);
  if (!support.update) {
    throw new TasksFeatureError(
      "Server does not support tasks/update",
      support.wire,
    );
  }

  try {
    const task = await manager.updateTask(
      params.serverId,
      params.taskId,
      params.inputResponses as never,
    );
    return { wire: support.wire, task };
  } catch (error) {
    rethrowUnknownTask(error, support.wire);
  }
}

export async function cancelTaskForWire(
  manager: Manager,
  params: { serverId: string; taskId: string },
) {
  const support = manager.getTasksSupport(params.serverId);
  if (!support.cancel) {
    throw new TasksFeatureError(
      "Server does not support task cancellation (tasks.cancel capability not declared)",
      support.wire,
    );
  }

  if (support.wire === "extension") {
    // The extension ack is empty and cancellation is cooperative: report the
    // request and let the caller re-poll for the eventual status.
    await manager.cancelTaskExt(params.serverId, params.taskId);
    return { wire: support.wire, task: null };
  }

  const task = await manager.cancelTask(params.serverId, params.taskId);
  return { wire: support.wire, task };
}

/**
 * Recognizes a task-creating `tools/call` result on either wire.
 *
 * Extension `CreateTaskResult` is flat (`resultType: "task"`); the legacy
 * 2025-11-25 form nests it under `task`. Returns null for a normal result —
 * on the extension the server is free to answer synchronously.
 */
function modelImmediateResponseOf(result: unknown): unknown {
  return (result as { _meta?: Record<string, unknown> } | null | undefined)
    ?._meta?.["io.modelcontextprotocol/model-immediate-response"];
}

export function detectCreatedTask(
  manager: Manager,
  serverId: string,
  result: unknown,
):
  | {
      status: "task_created";
      wire: string;
      task: unknown;
      modelImmediateResponse?: unknown;
    }
  | null {
  // No wire dispatch available (older embedder, test double) means no tasks:
  // never assume a wire on the create path.
  const wire =
    typeof manager.getTasksSupport === "function"
      ? manager.getTasksSupport(serverId).wire
      : "none";
  if (wire === "none") return null;

  const body = result as
    | { resultType?: string; task?: { taskId?: string; status?: string } }
    | null
    | undefined;

  if (wire === "extension") {
    // Flat `resultType: "task"` only, via the SDK's guard so the seam and this
    // route cannot drift on what counts as a creation. The nested legacy shape
    // is NOT accepted here: on the extension wire it would be a nonconforming
    // payload, and classifying it as a task creation would hide that from the
    // debugger.
    return isCreateTaskExtResult(body)
      ? {
          status: "task_created",
          wire,
          task: body,
          modelImmediateResponse: modelImmediateResponseOf(result),
        }
      : null;
  }
  if (body?.task?.taskId && body.task.status) {
    // Field parity with the local route envelope.
    return {
      status: "task_created",
      wire,
      task: body.task,
      modelImmediateResponse: modelImmediateResponseOf(result),
    };
  }
  return null;
}

export function taskCapabilitiesForWire(manager: Manager, serverId: string) {
  const support = manager.getTasksSupport(serverId);
  return {
    ...support,
    // Legacy boolean shape, kept one release for older clients.
    supportsToolCalls: support.toolCalls,
    supportsList: support.list,
    supportsCancel: support.cancel,
  };
}
