import { Hono } from "hono";
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
    listTools(manager, body),
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
