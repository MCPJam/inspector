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

type Manager = InstanceType<typeof MCPClientManager>;

export const TASK_UNKNOWN_OR_EXPIRED = "task-unknown-or-expired";

/**
 * JSON-RPC -32602 on a task read means the server no longer knows the task
 * (expired, purged after cancellation, or forgotten with the session).
 */
export function isUnknownTaskError(error: unknown): boolean {
  return (error as { code?: unknown } | null)?.code === -32602;
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
    throw new Error("Server has no tasks wire");
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
    throw new Error("Server has no tasks wire");
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
    throw new Error(
      "tasks/result exists only on the 2025-11-25 wire; use tasks/get (the result is inline)",
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
    throw new Error("Server does not support tasks/update");
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
    throw new Error(
      "Server does not support task cancellation (tasks.cancel capability not declared)",
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
export function detectCreatedTask(
  manager: Manager,
  serverId: string,
  result: unknown,
): { status: "task_created"; wire: string; task: unknown } | null {
  // Managers that predate wire dispatch (older embedders, test doubles) only
  // ever spoke the legacy wire.
  const wire =
    typeof manager.getTasksSupport === "function"
      ? manager.getTasksSupport(serverId).wire
      : "legacy";
  if (wire === "none") return null;

  const body = result as
    | { resultType?: string; task?: { taskId?: string; status?: string } }
    | null
    | undefined;

  if (wire === "extension" && body?.resultType === "task") {
    return { status: "task_created", wire, task: body };
  }
  if (body?.task?.taskId && body.task.status) {
    return { status: "task_created", wire, task: body.task };
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
