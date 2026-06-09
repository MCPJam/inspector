import { Hono } from "hono";
import { promptsListSchema } from "../web/auth.js";
import { listPrompts } from "../../utils/route-handlers.js";
import { runV1ServerOp } from "./adapter.js";
import { v1PageJson } from "./envelope.js";

const prompts = new Hono();

// POST /v1/projects/:projectId/servers/:serverId/prompts
// List the server's prompts. Wraps the same listPrompts core as
// /api/web/prompts/list.
prompts.post("/projects/:projectId/servers/:serverId/prompts", async (c) =>
  runV1ServerOp(
    c,
    promptsListSchema,
    (manager, body) => listPrompts(manager, body),
    (ctx, result: { prompts?: unknown[]; nextCursor?: string }) =>
      v1PageJson(ctx, result.prompts ?? [], result.nextCursor)
  )
);

export default prompts;
