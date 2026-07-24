import { Hono } from "hono";
import { captureServerEvent } from "../../utils/analytics.js";
import {
  toolsListSchema,
  toolsExecuteSchema,
  withEphemeralConnection,
  ErrorCode,
  WebRouteError,
} from "./auth.js";
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
  withEphemeralConnection(c, toolsExecuteSchema, async (manager, body) => {
    if (body.taskOptions) {
      throw new WebRouteError(
        400,
        ErrorCode.FEATURE_NOT_SUPPORTED,
        "Task-augmented tool execution is not supported in hosted mode",
      );
    }

    // Server twin of the client's `execute_tool` — captured at attempt time
    // (like the client) so the pair ratio isn't skewed by failures.
    captureServerEvent(c, "execute_tool_server", {
      tool_name: body.toolName,
      server_id: body.serverId,
    });

    try {
      const result = await manager.executeTool(
        body.serverId,
        body.toolName,
        body.parameters,
      );
      return {
        status: "completed",
        result,
      };
    } catch (error) {
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
  }),
);

export default tools;
