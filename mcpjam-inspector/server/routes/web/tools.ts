import { Hono } from "hono";
import { countToolsTokens } from "../../utils/tokenizer-helpers.js";
import {
  toolsListSchema,
  toolsExecuteSchema,
  withEphemeralConnection,
  ErrorCode,
  WebRouteError,
} from "./auth.js";

const tools = new Hono();

tools.post("/list", async (c) =>
  withEphemeralConnection(c, toolsListSchema, async (manager, body) => {
    const result = await manager.listTools(
      body.serverId,
      body.cursor ? { cursor: body.cursor } : undefined,
    );
    const toolsMetadata = manager.getAllToolsMetadata(body.serverId);
    const tokenCount = body.modelId
      ? await countToolsTokens(result.tools, body.modelId)
      : undefined;

    return {
      ...result,
      toolsMetadata,
      tokenCount,
      nextCursor: result.nextCursor,
    };
  }),
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
