import { Hono } from "hono";
import "../../types/hono";
import { progressStore } from "../../services/progress-store";

const tasks = new Hono();

// List all tasks for a server
tasks.post("/list", async (c) => {
  try {
    const { serverId, cursor } = (await c.req.json()) as {
      serverId?: string;
      cursor?: string;
    };

    if (!serverId) {
      return c.json({ error: "serverId is required" }, 400);
    }

    const result = await c.mcpClientManager.listTasks(serverId, cursor);
    return c.json(result);
  } catch (error) {
    console.error("Error listing tasks:", error);
    return c.json(
      { error: error instanceof Error ? error.message : "Unknown error" },
      500,
    );
  }
});

// Get a specific task
tasks.post("/get", async (c) => {
  try {
    const { serverId, taskId } = (await c.req.json()) as {
      serverId?: string;
      taskId?: string;
    };

    if (!serverId) return c.json({ error: "serverId is required" }, 400);
    if (!taskId) return c.json({ error: "taskId is required" }, 400);

    const result = await c.mcpClientManager.getTask(serverId, taskId);
    return c.json(result);
  } catch (error) {
    console.error("Error getting task:", error);
    return c.json(
      { error: error instanceof Error ? error.message : "Unknown error" },
      500,
    );
  }
});

// Get task result (for completed tasks)
// Per MCP Tasks spec: tasks/result returns the underlying request's result directly,
// with io.modelcontextprotocol/related-task in _meta
tasks.post("/result", async (c) => {
  try {
    const { serverId, taskId } = (await c.req.json()) as {
      serverId?: string;
      taskId?: string;
    };

    if (!serverId) return c.json({ error: "serverId is required" }, 400);
    if (!taskId) return c.json({ error: "taskId is required" }, 400);

    const result = await c.mcpClientManager.getTaskResult(serverId, taskId);

    // Per MCP Tasks spec (2025-11-25), the result should include the related task metadata
    // The SDK returns the raw result, we ensure the metadata is present
    const resultWithMeta = result as Record<string, unknown> | null;
    if (resultWithMeta && typeof resultWithMeta === "object") {
      // Ensure _meta exists and contains the related task info
      if (!resultWithMeta._meta) {
        resultWithMeta._meta = {};
      }
      (resultWithMeta._meta as Record<string, unknown>)[
        "io.modelcontextprotocol/related-task"
      ] = { taskId };
    }

    return c.json(result);
  } catch (error) {
    console.error("Error getting task result:", error);
    return c.json(
      { error: error instanceof Error ? error.message : "Unknown error" },
      500,
    );
  }
});

// Cancel a task
// Per MCP Tasks spec (2025-11-25): only attempt cancel if server declares tasks.cancel capability
tasks.post("/cancel", async (c) => {
  try {
    const { serverId, taskId } = (await c.req.json()) as {
      serverId?: string;
      taskId?: string;
    };

    if (!serverId) return c.json({ error: "serverId is required" }, 400);
    if (!taskId) return c.json({ error: "taskId is required" }, 400);

    // Check if server supports cancel operation before attempting
    if (!c.mcpClientManager.supportsTasksCancel(serverId)) {
      return c.json(
        {
          error:
            "Server does not support task cancellation (tasks.cancel capability not declared)",
        },
        400,
      );
    }

    const result = await c.mcpClientManager.cancelTask(serverId, taskId);
    return c.json(result);
  } catch (error) {
    console.error("Error cancelling task:", error);
    return c.json(
      { error: error instanceof Error ? error.message : "Unknown error" },
      500,
    );
  }
});

// Get task capabilities for a server (MCP Tasks spec 2025-11-25)
// Returns what task-related features the server supports
tasks.post("/capabilities", async (c) => {
  try {
    const { serverId } = (await c.req.json()) as {
      serverId?: string;
    };

    if (!serverId) return c.json({ error: "serverId is required" }, 400);

    const capabilities = {
      // Server supports task-augmented tools/call requests
      supportsToolCalls: c.mcpClientManager.supportsTasksForToolCalls(serverId),
      // Server supports tasks/list operation
      supportsList: c.mcpClientManager.supportsTasksList(serverId),
      // Server supports tasks/cancel operation
      supportsCancel: c.mcpClientManager.supportsTasksCancel(serverId),
    };

    return c.json(capabilities);
  } catch (error) {
    console.error("Error getting task capabilities:", error);
    return c.json(
      { error: error instanceof Error ? error.message : "Unknown error" },
      500,
    );
  }
});

// Get latest progress for a server
// Returns the most recent progress notification received
tasks.post("/progress", async (c) => {
  try {
    const { serverId } = (await c.req.json()) as {
      serverId?: string;
    };

    if (!serverId) return c.json({ error: "serverId is required" }, 400);

    const progress = progressStore.getLatestProgress(serverId);
    return c.json({ progress: progress ?? null });
  } catch (error) {
    console.error("Error getting progress:", error);
    return c.json(
      { error: error instanceof Error ? error.message : "Unknown error" },
      500,
    );
  }
});

// Get all active progress for a server
tasks.post("/progress/all", async (c) => {
  try {
    const { serverId } = (await c.req.json()) as {
      serverId?: string;
    };

    if (!serverId) return c.json({ error: "serverId is required" }, 400);

    const allProgress = progressStore.getAllProgress(serverId);
    return c.json({ progress: allProgress });
  } catch (error) {
    console.error("Error getting all progress:", error);
    return c.json(
      { error: error instanceof Error ? error.message : "Unknown error" },
      500,
    );
  }
});

export default tasks;
