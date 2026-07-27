/**
 * Hosted-mode MCP tasks routes.
 *
 * ## Durable deferred tasks via reconnect-per-poll
 *
 * The hosted plane is horizontally scaled and keeps no MCP sessions: every
 * request builds an ephemeral `MCPClientManager` (authorize → connect →
 * request → disconnect) on whichever replica the load balancer picked. Tasks
 * bind to the AUTHORIZATION context rather than the session on both wires, so
 * polling a task from a fresh connection is spec-blessed (SEP-2663 explicitly
 * tells clients to persist task IDs and resume polling after a restart) and
 * needs no session affinity, no worker, and no server-side registry.
 *
 * Consequences that shape this file:
 *
 * - **Task handles live client-side** (the localStorage tracker), so there is
 *   no `/list` of hosted tasks beyond what the server itself remembers; the
 *   legacy `/list` is a passthrough and the extension answers `{tasks: []}`.
 * - **`/get-batch` exists** so a TasksTab tick costs ONE connection per server
 *   instead of one per tracked task. `HOSTED_TASK_BATCH_MAX` caps it.
 * - **Progress/notification endpoints are absent**, not stubbed: they need a
 *   live notification stream that an ephemeral connection cannot have. Polling
 *   is the spec-guaranteed path; the hosted client renders no progress UI.
 * - **A forgotten task is normal, not an error.** A server that drops tasks
 *   when the session ends is spec-legal, so `-32602` maps to the stable
 *   `TASK_NOT_FOUND` code and the client marks the handle unavailable —
 *   distinguishable from a structureless 404 (older replica mid-rollout) and
 *   from a transient connect failure.
 */

import { Hono } from "hono";
import {
  taskCapabilitiesSchema,
  taskGetBatchSchema,
  taskGetSchema,
  taskListSchema,
  taskUpdateSchema,
  withEphemeralConnection,
} from "./auth.js";
import { ErrorCode, WebRouteError } from "./errors.js";
import {
  UnknownTaskError,
  cancelTaskForWire,
  getTaskForWire,
  getTaskResultForWire,
  getTasksBatchForWire,
  listTasksForWire,
  taskCapabilitiesForWire,
  updateTaskForWire,
} from "../../utils/task-route-handlers.js";

const tasks = new Hono();

/** A task the server no longer knows is a stable, client-actionable outcome. */
async function mapUnknownTask<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (error) {
    if (error instanceof UnknownTaskError) {
      throw new WebRouteError(404, ErrorCode.TASK_NOT_FOUND, error.message, {
        wire: error.wire,
      });
    }
    throw error;
  }
}

tasks.post("/capabilities", async (c) =>
  withEphemeralConnection(c, taskCapabilitiesSchema, async (manager, body) =>
    taskCapabilitiesForWire(manager, body.serverId),
  ),
);

tasks.post("/list", async (c) =>
  withEphemeralConnection(c, taskListSchema, (manager, body) =>
    listTasksForWire(manager, { serverId: body.serverId, cursor: body.cursor }),
  ),
);

tasks.post("/get", async (c) =>
  withEphemeralConnection(c, taskGetSchema, (manager, body) =>
    mapUnknownTask(() =>
      getTaskForWire(manager, {
        serverId: body.serverId,
        taskId: body.taskId,
      }),
    ),
  ),
);

// One connection per server per poll tick; per-task failures are reported
// inside the batch so one forgotten task can't fail the whole tick.
tasks.post("/get-batch", async (c) =>
  withEphemeralConnection(c, taskGetBatchSchema, (manager, body) =>
    getTasksBatchForWire(manager, {
      serverId: body.serverId,
      taskIds: body.taskIds,
    }),
  ),
);

// Legacy only: the extension carries the result inline on tasks/get.
tasks.post("/result", async (c) =>
  withEphemeralConnection(c, taskGetSchema, (manager, body) =>
    mapUnknownTask(() =>
      getTaskResultForWire(manager, {
        serverId: body.serverId,
        taskId: body.taskId,
      }),
    ),
  ),
);

// Extension only: submit responses to the keyed inputRequests snapshot.
tasks.post("/update", async (c) =>
  withEphemeralConnection(c, taskUpdateSchema, (manager, body) =>
    mapUnknownTask(() =>
      updateTaskForWire(manager, {
        serverId: body.serverId,
        taskId: body.taskId,
        inputResponses: body.inputResponses,
      }),
    ),
  ),
);

tasks.post("/cancel", async (c) =>
  withEphemeralConnection(c, taskGetSchema, (manager, body) =>
    mapUnknownTask(() =>
      cancelTaskForWire(manager, {
        serverId: body.serverId,
        taskId: body.taskId,
      }),
    ),
  ),
);

export default tasks;
