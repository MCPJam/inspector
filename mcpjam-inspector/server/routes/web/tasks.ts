/**
 * Hosted Task operations reconnect for each request. A saved account pin must
 * still be authorized; it never falls back to the current default account.
 *
 * Live state comes from the MCP server. The caller-scoped recovery index only
 * retains handles, including extension tasks that have no tasks/list method.
 * Batch polling shares a connection within one server/account/wire scope.
 *
 * A server's unknown-task response marks that handle unavailable. Transient
 * connection failures remain retryable and do not discard the handle.
 */

import { Hono } from "hono";
import type { Context } from "hono";
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
  TASK_UNKNOWN_OR_EXPIRED,
  TasksFeatureError,
  UnknownTaskError,
  cancelTaskForWire,
  getTaskForWire,
  getTaskResultForWire,
  getTasksBatchForWire,
  listTasksForWire,
  taskCapabilitiesForWire,
  updateTaskForWire,
} from "../../utils/task-route-handlers.js";
import {
  listRegistryTasks,
  reportTaskStatuses,
} from "../../services/hosted-task-registry.js";
import {
  toRegistryTaskStatus,
  type RegistryTaskEntry,
  type RegistryTaskStatus,
} from "../../../shared/hosted-tasks.js";
import { getConvexBearerForRequest } from "../../utils/v1-convex-token.js";
import { logger } from "../../utils/logger.js";

import { taskConnectionKey } from "../../utils/task-connection-key.js";

const tasks = new Hono();

/**
 * A scenario visitor is not a project member — the registry's forwarded-bearer
 * membership check would 403 them — and their tasks are the chat surface's
 * concern, not this tab's. Skipping is a scope decision, not a guest one:
 * guests are ordinary members here (see the backend route header — "Guests
 * are not a special case").
 */
function isScenarioScoped(body: {
  accessScope?: "project_member" | "chat_v2";
  scenarioId?: string;
}): boolean {
  return body.accessScope === "chat_v2" || Boolean(body.scenarioId);
}

/**
 * The recovery-index read attached to `/list`. Best-effort by construction:
 * `null` means "no recovery source this tick" (skipped, unconfigured,
 * disabled, or unreachable) and the caller must omit the field entirely —
 * `[]` is reserved for a verified empty registry.
 */
async function fetchRegistryTasks(
  c: Context,
  body: {
    projectId: string;
    serverId: string;
    connectionId?: string;
    accessScope?: "project_member" | "chat_v2";
    scenarioId?: string;
  },
): Promise<RegistryTaskEntry[] | null> {
  if (isScenarioScoped(body)) return null;
  try {
    // Throws when the internal backend isn't configured (local/OSS deploys):
    // that is "no recovery source", not an error.
    const bearer = await getConvexBearerForRequest(c);
    return await listRegistryTasks({
      bearer,
      projectId: body.projectId,
      serverId: body.serverId,
      ...(body.connectionId !== undefined
        ? { connectionId: body.connectionId }
        : {}),
    });
  } catch (error) {
    logger.warn("[web/tasks] registry recovery read unavailable", {
      serverId: body.serverId,
      error: error instanceof Error ? error.message : String(error),
    });
    return null;
  }
}

/**
 * Feeds what a `/get-batch` poll actually observed back to the registry,
 * AFTER the poll result is already in hand. Fire-and-forget: it is never
 * awaited by the route, never bound to the request signal (a client that
 * disconnected mid-poll still observed these statuses), and a failure is a
 * single warn — the poll already succeeded and must stay succeeded.
 *
 * `TASK_UNKNOWN_OR_EXPIRED` maps to the registry's own `expired` status: a
 * live read answered "the server forgot this handle", which is exactly the
 * observation that lets the backend retire the row.
 */
async function reportObservedStatuses(
  c: Context,
  body: {
    projectId: string;
    serverId: string;
    connectionId?: string;
    accessScope?: "project_member" | "chat_v2";
    scenarioId?: string;
  },
  result: {
    wire: string;
    tasks: Array<{ taskId: string; task?: unknown; code?: string }>;
  },
): Promise<void> {
  try {
    if (isScenarioScoped(body)) return;
    if (result.wire !== "legacy" && result.wire !== "extension") return;
    const wire = result.wire;
    const updates: Array<{
      wire: "legacy" | "extension";
      taskId: string;
      status: RegistryTaskStatus;
    }> = [];
    for (const entry of result.tasks) {
      const status =
        entry.code === TASK_UNKNOWN_OR_EXPIRED
          ? ("expired" as const)
          : toRegistryTaskStatus(
              (entry.task as { status?: unknown } | undefined)?.status,
            );
      if (status === null) continue;
      updates.push({ wire, taskId: entry.taskId, status });
    }
    if (updates.length === 0) return;
    const bearer = await getConvexBearerForRequest(c);
    // `reportTaskStatuses` never throws and stamps `observed: true` on every
    // update — these all came from a live read that answered.
    await reportTaskStatuses(
      {
        bearer,
        projectId: body.projectId,
        serverId: body.serverId,
        connectionId: body.connectionId,
      },
      updates,
    );
  } catch (error) {
    logger.warn("[web/tasks] registry status report skipped", {
      serverId: body.serverId,
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

/**
 * Maps the two task-specific failure classes onto stable client-actionable
 * outcomes: a forgotten task (404 `TASK_NOT_FOUND`) and a request the resolved
 * wire cannot serve (400 `TASKS_UNSUPPORTED`). Anything else stays a 500.
 */
async function mapTaskErrors<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (error) {
    if (error instanceof UnknownTaskError) {
      throw new WebRouteError(404, ErrorCode.TASK_NOT_FOUND, error.message, {
        wire: error.wire,
      });
    }
    if (error instanceof TasksFeatureError) {
      throw new WebRouteError(400, ErrorCode.TASKS_UNSUPPORTED, error.message, {
        wire: error.wire,
      });
    }
    throw error;
  }
}

tasks.post("/capabilities", async (c) =>
  withEphemeralConnection(c, taskCapabilitiesSchema, async (manager, body) =>
    taskCapabilitiesForWire(manager, taskConnectionKey(manager, body)),
  ),
);

// Both wires. On the extension wire — where this route answers `{tasks: []}`
// locally — the attached registry read is the ONLY discovery source a fresh
// browser has, since the extension removed `tasks/list` and the tracker is
// empty. AWAITED (unlike the /get-batch report): the whole point of the read
// is to be in this response.
tasks.post("/list", async (c) =>
  withEphemeralConnection(c, taskListSchema, async (manager, body) => {
    const result = await mapTaskErrors(() =>
      listTasksForWire(manager, {
        serverId: taskConnectionKey(manager, body),
        cursor: body.cursor,
      }),
    );
    const registryTasks = await fetchRegistryTasks(c, body);
    // Attached only when non-null: an ABSENT field means "no recovery source
    // this tick" while `registryTasks: []` is a verified empty registry, and
    // the client is entitled to treat those differently.
    return registryTasks === null ? result : { ...result, registryTasks };
  }),
);

// Reports its single observation exactly like /get-batch does — hosted legacy
// handles are refreshed through THIS path when only one of them is due, and
// without the report their registry rows' lastKnownStatus/lastObservedAt go
// stale and can be pruned as unobservable despite active polling. A -32602 is
// still an observation (the one that lets the backend retire the row), so it
// reports `expired` before the mapped 404 propagates.
tasks.post("/get", async (c) =>
  withEphemeralConnection(c, taskGetSchema, async (manager, body) => {
    try {
      const result = await mapTaskErrors(() =>
        getTaskForWire(manager, {
          serverId: taskConnectionKey(manager, body),
          taskId: body.taskId,
        }),
      );
      void reportObservedStatuses(c, body, {
        wire: result.wire,
        tasks: [{ taskId: body.taskId, task: result.task }],
      });
      return result;
    } catch (error) {
      if (
        error instanceof WebRouteError &&
        error.code === ErrorCode.TASK_NOT_FOUND
      ) {
        const wire = (error.details as { wire?: string } | undefined)?.wire;
        void reportObservedStatuses(c, body, {
          wire: wire ?? "none",
          tasks: [{ taskId: body.taskId, code: TASK_UNKNOWN_OR_EXPIRED }],
        });
      }
      throw error;
    }
  }),
);

// One connection per server per poll tick; per-task failures are reported
// inside the batch so one forgotten task can't fail the whole tick.
tasks.post("/get-batch", async (c) =>
  withEphemeralConnection(c, taskGetBatchSchema, async (manager, body) => {
    const result = await mapTaskErrors(() =>
      getTasksBatchForWire(manager, {
        serverId: taskConnectionKey(manager, body),
        taskIds: body.taskIds,
      }),
    );
    // AFTER the result is in hand and deliberately un-awaited: the report is
    // registry bookkeeping and must never delay or fail the poll. The helper
    // catches everything, so this dangling promise cannot reject.
    void reportObservedStatuses(c, body, result);
    return result;
  }),
);

// Legacy only: the extension carries the result inline on tasks/get.
tasks.post("/result", async (c) =>
  withEphemeralConnection(c, taskGetSchema, (manager, body) =>
    mapTaskErrors(() =>
      getTaskResultForWire(manager, {
        serverId: taskConnectionKey(manager, body),
        taskId: body.taskId,
      }),
    ),
  ),
);

// Extension only: submit responses to the keyed inputRequests snapshot.
tasks.post("/update", async (c) =>
  withEphemeralConnection(c, taskUpdateSchema, (manager, body) =>
    mapTaskErrors(() =>
      updateTaskForWire(manager, {
        serverId: taskConnectionKey(manager, body),
        taskId: body.taskId,
        inputResponses: body.inputResponses,
      }),
    ),
  ),
);

tasks.post("/cancel", async (c) =>
  withEphemeralConnection(c, taskGetSchema, (manager, body) =>
    mapTaskErrors(() =>
      cancelTaskForWire(manager, {
        serverId: taskConnectionKey(manager, body),
        taskId: body.taskId,
      }),
    ),
  ),
);

export default tasks;
