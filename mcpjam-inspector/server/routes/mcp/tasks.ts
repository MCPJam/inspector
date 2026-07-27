import { Hono } from "hono";
import "../../types/hono";
import { progressStore } from "../../services/progress-store";
import { logger } from "../../utils/logger";
import {
  TasksFeatureError,
  UnknownTaskError,
  cancelTaskForWire,
  getTaskForWire,
  getTaskResultForWire,
  listTasksForWire,
  taskCapabilitiesForWire,
  updateTaskForWire,
} from "../../utils/task-route-handlers";

const tasks = new Hono();

/**
 * Tasks exist on two mutually incompatible wires: the 2025-11-25 in-core
 * utility ("legacy") and the io.modelcontextprotocol/tasks extension
 * ("extension", 2026-07-28+). The wire dispatch itself lives in
 * `utils/task-route-handlers` so the hosted routes share it verbatim; these
 * routes only validate input and map handler outcomes onto HTTP.
 */

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : "Unknown error";
}

function requireIds(body: { serverId?: string; taskId?: string }) {
  if (!body.serverId) return "serverId is required";
  if (!body.taskId) return "taskId is required";
  return null;
}

/**
 * A tasks request the resolved wire cannot serve is a caller/feature error:
 * 400 with the resolved wire, never a 500.
 */
function featureErrorResponse(error: unknown) {
  return error instanceof TasksFeatureError
    ? ({ body: { error: error.message, code: error.code, wire: error.wire } , status: 400 } as const)
    : null;
}

tasks.post("/list", async (c) => {
  try {
    const { serverId, cursor } = (await c.req.json()) as {
      serverId?: string;
      cursor?: string;
    };
    if (!serverId) return c.json({ error: "serverId is required" }, 400);

    return c.json(
      await listTasksForWire(c.mcpClientManager, { serverId, cursor }),
    );
  } catch (error) {
    const feature = featureErrorResponse(error);
    if (feature) return c.json(feature.body, feature.status);
    logger.error("Error listing tasks", error);
    return c.json({ error: errorMessage(error) }, 500);
  }
});

tasks.post("/get", async (c) => {
  const body = (await c.req.json()) as { serverId?: string; taskId?: string };
  const missing = requireIds(body);
  if (missing) return c.json({ error: missing }, 400);

  try {
    return c.json(
      await getTaskForWire(c.mcpClientManager, {
        serverId: body.serverId as string,
        taskId: body.taskId as string,
      }),
    );
  } catch (error) {
    if (error instanceof UnknownTaskError) {
      return c.json(
        { error: error.message, code: error.code, wire: error.wire },
        404,
      );
    }
    const feature = featureErrorResponse(error);
    if (feature) return c.json(feature.body, feature.status);
    logger.error("Error getting task", error);
    return c.json({ error: errorMessage(error) }, 500);
  }
});

// Legacy only: the extension carries the result inline on tasks/get.
tasks.post("/result", async (c) => {
  const body = (await c.req.json()) as { serverId?: string; taskId?: string };
  const missing = requireIds(body);
  if (missing) return c.json({ error: missing }, 400);

  const support = c.mcpClientManager.getTasksSupport(body.serverId as string);
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

  try {
    return c.json(
      await getTaskResultForWire(c.mcpClientManager, {
        serverId: body.serverId as string,
        taskId: body.taskId as string,
      }),
    );
  } catch (error) {
    const feature = featureErrorResponse(error);
    if (feature) return c.json(feature.body, feature.status);
    logger.error("Error getting task result", error);
    return c.json({ error: errorMessage(error) }, 500);
  }
});

// Extension only: submit responses to the keyed inputRequests snapshot.
tasks.post("/update", async (c) => {
  const body = (await c.req.json()) as {
    serverId?: string;
    taskId?: string;
    inputResponses?: Record<string, unknown>;
  };
  const missing = requireIds(body);
  if (missing) return c.json({ error: missing }, 400);
  if (!body.inputResponses || typeof body.inputResponses !== "object") {
    return c.json({ error: "inputResponses is required" }, 400);
  }

  const support = c.mcpClientManager.getTasksSupport(body.serverId as string);
  if (!support.update) {
    return c.json(
      { error: "Server does not support tasks/update", wire: support.wire },
      400,
    );
  }

  try {
    return c.json(
      await updateTaskForWire(c.mcpClientManager, {
        serverId: body.serverId as string,
        taskId: body.taskId as string,
        inputResponses: body.inputResponses,
      }),
    );
  } catch (error) {
    if (error instanceof UnknownTaskError) {
      return c.json(
        { error: error.message, code: error.code, wire: error.wire },
        404,
      );
    }
    const feature = featureErrorResponse(error);
    if (feature) return c.json(feature.body, feature.status);
    logger.error("Error updating task", error);
    return c.json({ error: errorMessage(error) }, 500);
  }
});

tasks.post("/cancel", async (c) => {
  const body = (await c.req.json()) as { serverId?: string; taskId?: string };
  const missing = requireIds(body);
  if (missing) return c.json({ error: missing }, 400);

  const support = c.mcpClientManager.getTasksSupport(body.serverId as string);
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

  try {
    return c.json(
      await cancelTaskForWire(c.mcpClientManager, {
        serverId: body.serverId as string,
        taskId: body.taskId as string,
      }),
    );
  } catch (error) {
    const feature = featureErrorResponse(error);
    if (feature) return c.json(feature.body, feature.status);
    logger.error("Error cancelling task", error);
    return c.json({ error: errorMessage(error) }, 500);
  }
});

tasks.post("/capabilities", async (c) => {
  try {
    const { serverId } = (await c.req.json()) as { serverId?: string };
    if (!serverId) return c.json({ error: "serverId is required" }, 400);

    return c.json(taskCapabilitiesForWire(c.mcpClientManager, serverId));
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
