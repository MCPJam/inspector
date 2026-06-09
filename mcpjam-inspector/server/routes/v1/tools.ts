import { Hono } from "hono";
import { toolsListSchema } from "../web/auth.js";
import { listTools } from "../../utils/route-handlers.js";
import { runV1ServerOp } from "./adapter.js";
import { v1PageJson } from "./envelope.js";

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

export default tools;
