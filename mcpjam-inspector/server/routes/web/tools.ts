import { Hono } from "hono";
import { captureServerEvent } from "../../utils/analytics.js";
import {
  toolsListSchema,
  toolsExecuteSchema,
  withEphemeralConnection,
  ErrorCode,
  WebRouteError,
} from "./auth.js";
import { runHostedDirectMrtrOperation } from "./mrtr-direct.js";
import { isMrtrSuspendedSignal } from "../../utils/mrtr-hosted-collector.js";
import { listTools } from "../../utils/route-handlers.js";
import { getRequestLogger } from "../../utils/request-logger.js";
import { classifyError } from "../../utils/error-classify.js";

const tools = new Hono();

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
      if (body.taskOptions) {
        throw new WebRouteError(
          400,
          ErrorCode.FEATURE_NOT_SUPPORTED,
          "Task-augmented tool execution is not supported in hosted mode",
        );
      }

      // Server twin of the client's `execute_tool` — captured at attempt
      // time (like the client) so the pair ratio isn't skewed by failures.
      captureServerEvent(c, "execute_tool_server", {
        tool_name: body.toolName,
        server_id: body.serverId,
      });

      forwardLogMessages(body.serverId);

      try {
        const result = await manager.executeTool(
          body.serverId,
          body.toolName,
          body.parameters,
        );
        return {
          status: "completed" as const,
          result,
        };
      } catch (error) {
        // A suspend is control flow, not a failed execution — let it propagate
        // to the MRTR wrapper unlogged so the pair ratio isn't skewed.
        if (isMrtrSuspendedSignal(error)) throw error;
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
