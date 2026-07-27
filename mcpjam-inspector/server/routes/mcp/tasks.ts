import { Hono } from "hono";
import "../../types/hono";
import { progressStore } from "../../services/progress-store";
import { logger } from "../../utils/logger";

const tasks = new Hono();

/**
 * Tasks exist on two mutually incompatible wires: the 2025-11-25 in-core
 * utility ("legacy") and the io.modelcontextprotocol/tasks extension
 * ("extension", 2026-07-28+). Every route below dispatches on the wire the
 * SDK resolved for the connection; `wire: "none"` means the connection has no
 * tasks surface at all and task routes must not touch the network.
 */

const TASK_UNKNOWN_OR_EXPIRED = "task-unknown-or-expired";

// JSON-RPC -32602 on a task read means the server no longer knows the task
// (expired, purged after cancellation, or forgotten with the session).
function isUnknownTaskError(error: unknown): boolean {
  const code = (error as { code?: unknown } | null)?.code;
  return code === -32602;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : "Unknown error";
}

tasks.post("/list", async (c) => {
  try {
    const { serverId, cursor } = (await c.req.json()) as {
      serverId?: string;
      cursor?: string;
    };

    if (!serverId) {
      return c.json({ error: "serverId is required" }, 400);
    }

    const support = c.mcpClientManager.getTasksSupport(serverId);
    if (!support.list) {
      // The extension has no tasks/list: the client-side tracker is the list.
      // Answering locally keeps this the single seam a future registry fills.
      return c.json({ tasks: [], wire: support.wire });
    }

    const result = await c.mcpClientManager.listTasks(serverId, cursor);
    return c.json({ ...result, wire: support.wire });
  } catch (error) {
    logger.error("Error listing tasks", error);
    return c.json({ error: errorMessage(error) }, 500);
  }
});

tasks.post("/get", async (c) => {
  try {
    const { serverId, taskId } = (await c.req.json()) as {
      serverId?: string;
      taskId?: string;
    };

    if (!serverId) return c.json({ error: "serverId is required" }, 400);
    if (!taskId) return c.json({ error: "taskId is required" }, 400);

    const support = c.mcpClientManager.getTasksSupport(serverId);
    if (support.wire === "none") {
      return c.json({ error: "Server has no tasks wire" }, 400);
    }

    try {
      const task =
        support.wire === "extension"
          ? await c.mcpClientManager.getTaskExt(serverId, taskId)
          : await c.mcpClientManager.getTask(serverId, taskId);
      return c.json({ wire: support.wire, task });
    } catch (error) {
      if (isUnknownTaskError(error)) {
        return c.json(
          {
            error: errorMessage(error),
            code: TASK_UNKNOWN_OR_EXPIRED,
            wire: support.wire,
          },
          404,
        );
      }
      throw error;
    }
  } catch (error) {
    logger.error("Error getting task", error);
    return c.json({ error: errorMessage(error) }, 500);
  }
});

// Legacy only: the extension carries the result inline on tasks/get.
tasks.post("/result", async (c) => {
  try {
    const { serverId, taskId } = (await c.req.json()) as {
      serverId?: string;
      taskId?: string;
    };

    if (!serverId) return c.json({ error: "serverId is required" }, 400);
    if (!taskId) return c.json({ error: "taskId is required" }, 400);

    const support = c.mcpClientManager.getTasksSupport(serverId);
    if (support.wire !== "legacy") {
      return c.json(
        {
          error:
            "tasks/result exists only on the 2025-11-25 wire; use tasks/get (the result is inline)",
          wire: support.wire,
        },
        400,
      );
    }

    const result = await c.mcpClientManager.getTaskResult(serverId, taskId);

    const resultWithMeta = result as Record<string, unknown> | null;
    if (resultWithMeta && typeof resultWithMeta === "object") {
      if (!resultWithMeta._meta) {
        resultWithMeta._meta = {};
      }
      (resultWithMeta._meta as Record<string, unknown>)[
        "io.modelcontextprotocol/related-task"
      ] = { taskId };
    }

    return c.json(result);
  } catch (error) {
    logger.error("Error getting task result", error);
    return c.json({ error: errorMessage(error) }, 500);
  }
});

// Extension only: submit responses to the keyed inputRequests snapshot.
tasks.post("/update", async (c) => {
  try {
    const { serverId, taskId, inputResponses } = (await c.req.json()) as {
      serverId?: string;
      taskId?: string;
      inputResponses?: Record<string, unknown>;
    };

    if (!serverId) return c.json({ error: "serverId is required" }, 400);
    if (!taskId) return c.json({ error: "taskId is required" }, 400);
    if (!inputResponses || typeof inputResponses !== "object") {
      return c.json({ error: "inputResponses is required" }, 400);
    }

    const support = c.mcpClientManager.getTasksSupport(serverId);
    if (!support.update) {
      return c.json(
        { error: "Server does not support tasks/update", wire: support.wire },
        400,
      );
    }

    try {
      const task = await c.mcpClientManager.updateTask(
        serverId,
        taskId,
        inputResponses as never,
      );
      return c.json({ wire: support.wire, task });
    } catch (error) {
      if (isUnknownTaskError(error)) {
        return c.json(
          {
            error: errorMessage(error),
            code: TASK_UNKNOWN_OR_EXPIRED,
            wire: support.wire,
          },
          404,
        );
      }
      throw error;
    }
  } catch (error) {
    logger.error("Error updating task", error);
    return c.json({ error: errorMessage(error) }, 500);
  }
});

tasks.post("/cancel", async (c) => {
  try {
    const { serverId, taskId } = (await c.req.json()) as {
      serverId?: string;
      taskId?: string;
    };

    if (!serverId) return c.json({ error: "serverId is required" }, 400);
    if (!taskId) return c.json({ error: "taskId is required" }, 400);

    const support = c.mcpClientManager.getTasksSupport(serverId);
    if (!support.cancel) {
      return c.json(
        {
          error:
            "Server does not support task cancellation (tasks.cancel capability not declared)",
          wire: support.wire,
        },
        400,
      );
    }

    if (support.wire === "extension") {
      // The extension ack is empty and cancellation is cooperative: report the
      // request, let the caller re-poll for the eventual status.
      await c.mcpClientManager.cancelTaskExt(serverId, taskId);
      return c.json({ wire: support.wire, task: null });
    }

    const task = await c.mcpClientManager.cancelTask(serverId, taskId);
    return c.json({ wire: support.wire, task });
  } catch (error) {
    logger.error("Error cancelling task", error);
    return c.json({ error: errorMessage(error) }, 500);
  }
});

tasks.post("/capabilities", async (c) => {
  try {
    const { serverId } = (await c.req.json()) as { serverId?: string };

    if (!serverId) return c.json({ error: "serverId is required" }, 400);

    const support = c.mcpClientManager.getTasksSupport(serverId);

    return c.json({
      ...support,
      // Legacy boolean shape, kept one release for older clients.
      supportsToolCalls: support.toolCalls,
      supportsList: support.list,
      supportsCancel: support.cancel,
    });
  } catch (error) {
    logger.error("Error getting task capabilities", error);
    return c.json({ error: errorMessage(error) }, 500);
  }
});

// Progress is local-only: hosted connections are ephemeral per request.
tasks.post("/progress", async (c) => {
  try {
    const { serverId } = (await c.req.json()) as { serverId?: string };

    if (!serverId) return c.json({ error: "serverId is required" }, 400);

    const progress = progressStore.getLatestProgress(serverId);
    return c.json({ progress: progress ?? null });
  } catch (error) {
    logger.error("Error getting progress", error);
    return c.json({ error: errorMessage(error) }, 500);
  }
});

tasks.post("/progress/all", async (c) => {
  try {
    const { serverId } = (await c.req.json()) as { serverId?: string };

    if (!serverId) return c.json({ error: "serverId is required" }, 400);

    const allProgress = progressStore.getAllProgress(serverId);
    return c.json({ progress: allProgress });
  } catch (error) {
    logger.error("Error getting all progress", error);
    return c.json({ error: errorMessage(error) }, 500);
  }
});

export default tasks;
