import { Hono } from "hono";
import { isMCPTasksWireError } from "@mcpjam/sdk";
import { captureServerEvent } from "../../utils/analytics.js";
import {
  toolsListSchema,
  toolsExecuteSchema,
  withEphemeralConnection,
} from "./auth.js";
import { ErrorCode, WebRouteError } from "./errors.js";
import { runHostedDirectMrtrOperation } from "./mrtr-direct.js";
import { isMrtrSuspendedSignal } from "../../utils/mrtr-hosted-collector.js";
import { listTools } from "../../utils/route-handlers.js";
import { detectCreatedTask } from "../../utils/task-route-handlers.js";
import { toRegistryTaskStatus } from "../../../shared/hosted-tasks.js";
import { recordCreatedTask } from "../../services/hosted-task-registry.js";
import { getConvexBearerForRequest } from "../../utils/v1-convex-token.js";
import { logger } from "../../utils/logger.js";
import { getRequestLogger } from "../../utils/request-logger.js";
import { classifyError } from "../../utils/error-classify.js";

const tools = new Hono();

/**
 * Writes a recovery-index row for a task the hosted `tools/execute` route just
 * created — the Tools-tab twin of the chat route's task-created sink consumer.
 *
 * Fire-and-forget: never awaited by the route, catches everything, and a
 * failure is one warn — the tool call already succeeded and the task is
 * running on the MCP server whether or not this row lands.
 *
 * Chatbox visitors are skipped (they are not project members; the registry's
 * membership check on the forwarded bearer would 403 them). There is
 * deliberately NO guest branch: the backend route header says "Guests are not
 * a special case" — a guest session has a real `users` row and the same
 * organization-membership authorization as an authed user, so branching on
 * guestness here would only create the fork the backend removed.
 */
async function registerCreatedTaskInRegistry(
  c: Parameters<typeof getConvexBearerForRequest>[0],
  body: {
    projectId: string;
    serverId: string;
    accessScope?: "project_member" | "chat_v2";
    chatboxId?: string;
  },
  created: { wire: string; task: unknown },
): Promise<void> {
  try {
    if (body.accessScope === "chat_v2" || body.chatboxId) return;
    if (created.wire !== "legacy" && created.wire !== "extension") return;
    const task = created.task as
      | { taskId?: unknown; status?: unknown; createdAt?: unknown }
      | null
      | undefined;
    if (typeof task?.taskId !== "string" || task.taskId.length === 0) return;
    const createdAt =
      typeof task.createdAt === "string" ? Date.parse(task.createdAt) : NaN;
    // Extension statuses hyphenate; the registry stores underscores. An
    // unrecognized status is omitted (the service defaults to "working")
    // rather than sent — the backend 400s unknown statuses.
    const status = toRegistryTaskStatus(task.status);
    const bearer = await getConvexBearerForRequest(c);
    await recordCreatedTask(
      { bearer, projectId: body.projectId, serverId: body.serverId },
      {
        wire: created.wire,
        taskId: task.taskId,
        ...(status !== null ? { status } : {}),
        ...(Number.isFinite(createdAt) ? { createdAt } : {}),
      },
    );
  } catch (error) {
    logger.warn("[web/tools] task registry write skipped", {
      serverId: body.serverId,
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

tools.post("/list", async (c) =>
  withEphemeralConnection(c, toolsListSchema, (manager, body) =>
    // Hosted direct-ops read the server's live surface — never a cached
    // body — so raw/conformance evidence can't be masked by a stale serve.
    listTools(manager, { ...body, cacheMode: "bypass" }),
  ),
);

tools.post("/execute", async (c) =>
  // Hosted DIRECT tools/call (§12.3). A modern server can return an
  // `input_required` result mid-call; the MRTR collector then SUSPENDS the op
  // to the durable continuation store and this returns a typed
  // `{ status: "input_required", continuationId, ... }` pending outcome instead
  // of blocking the worker (§12.5.2). A non-suspending call returns
  // `{ status: "completed", result }` exactly as before.
  runHostedDirectMrtrOperation(
    c,
    toolsExecuteSchema,
    { method: "tools/call" },
    async (manager, body, forwardLogMessages) => {
      // Server twin of the client's `execute_tool` — captured at attempt
      // time (like the client) so the pair ratio isn't skewed by failures.
      captureServerEvent(c, "execute_tool_server", {
        tool_name: body.toolName,
        server_id: body.serverId,
      });

      forwardLogMessages(body.serverId);

      try {
        // Task creation is awaited here, INSIDE the ephemeral connection: the
        // CreateTaskResult must be in hand before the `finally` disconnect.
        // Durability past that point is the MCP server's spec obligation —
        // the task must be readable via `tasks/get` from a fresh connection.
        const result = body.allowTaskResult
          ? await manager.executeTool(
              body.serverId,
              body.toolName,
              body.parameters,
              { allowTaskResult: true },
            )
          : await manager.executeTool(
              body.serverId,
              body.toolName,
              body.parameters,
              undefined,
              body.taskOptions,
            );
        const created = detectCreatedTask(manager, body.serverId, result);
        if (created) {
          // Recovery-index write, deliberately un-awaited: the CreateTaskResult
          // is already in hand, and a registry outage must never convert this
          // successful tool call into a failure. The helper catches everything,
          // so the dangling promise cannot reject. A non-task result writes
          // nothing — the registry indexes task handles, not tool calls.
          void registerCreatedTaskInRegistry(c, body, created);
          return created;
        }

        return {
          status: "completed" as const,
          result,
        };
      } catch (error) {
        // A suspend is control flow, not a failed execution — let it propagate
        // to the MRTR wrapper unlogged so the pair ratio isn't skewed.
        if (isMrtrSuspendedSignal(error)) throw error;
        // Same taxonomy as /api/web/tasks/*: a task request the resolved wire
        // cannot serve is a client-actionable 400, never a 500 — PR5's client
        // treats non-TASKS_UNSUPPORTED failures as transient and would
        // otherwise retry a wire mismatch forever.
        if (isMCPTasksWireError(error)) {
          throw new WebRouteError(
            400,
            ErrorCode.TASKS_UNSUPPORTED,
            error.message,
            { wire: error.wire },
          );
        }
        getRequestLogger(c, "routes.web.tools").event(
          "mcp.tool.execution.failed",
          {
            toolName: body.toolName,
            serverId: body.serverId,
            errorCode: classifyError(error),
          },
          { error: error instanceof Error ? error : undefined },
        );
        throw error;
      }
    },
  ),
);

export default tools;
