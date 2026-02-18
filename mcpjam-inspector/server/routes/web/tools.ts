import { Hono } from "hono";
import {
  toolsListSchema,
  toolsExecuteSchema,
  withEphemeralConnection,
  ErrorCode,
  WebRouteError,
} from "./auth.js";
import { listTools } from "../../utils/route-handlers.js";

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

    const result = await manager.executeTool(
      body.serverId,
      body.toolName,
      body.parameters,
    );
    return {
      status: "completed",
      result,
    };
  }),
);

export default tools;
