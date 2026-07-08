import { Hono } from "hono";
import { toolsExecuteSchema, toolsListSchema } from "../web/auth.js";
import { ErrorCode, WebRouteError } from "../web/errors.js";
import { listTools } from "../../utils/route-handlers.js";
import { runV1ServerOp } from "./adapter.js";
import { v1PageJson, v1Resource } from "./envelope.js";

const tools = new Hono();

// POST /v1/projects/:projectId/servers/:serverId/tools
// List the server's tools. Wraps the same listTools core as /api/web/tools/list,
// projecting the MCP result into the canonical { items, nextCursor? } page.
// (The inspector-only toolsMetadata/tokenCount enrichments are intentionally
// dropped at the public boundary.)
tools.post("/projects/:projectId/servers/:serverId/tools", async (c) =>
  runV1ServerOp(
    c,
    toolsListSchema,
    (manager, body) => listTools(manager, body),
    (ctx, result: { tools?: unknown[]; nextCursor?: string }) =>
      v1PageJson(ctx, result.tools ?? [], result.nextCursor)
  )
);

// POST /v1/projects/:projectId/servers/:serverId/tools/call
// Execute a tool and return the MCP CallToolResult directly. Tool-level
// failures (result.isError === true) are successful calls — the server
// answered; only transport/auth errors flow through the v1 error envelope.
// Mirrors /api/web/tools/execute, including the hosted task restriction.
tools.post("/projects/:projectId/servers/:serverId/tools/call", async (c) =>
  runV1ServerOp(
    c,
    toolsExecuteSchema,
    async (manager, body) => {
      if (body.taskOptions) {
        throw new WebRouteError(
          400,
          ErrorCode.FEATURE_NOT_SUPPORTED,
          "Task-augmented tool execution is not supported on /api/v1"
        );
      }
      return await manager.executeTool(
        body.serverId,
        body.toolName,
        body.parameters
      );
    },
    (ctx, result) => v1Resource(ctx, result)
  )
);

export default tools;
