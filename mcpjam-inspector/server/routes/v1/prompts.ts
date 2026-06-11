import { Hono } from "hono";
import { promptsGetSchema, promptsListSchema } from "../web/auth.js";
import { getPrompt, listPrompts } from "../../utils/route-handlers.js";
import { runV1ServerOp } from "./adapter.js";
import { v1PageJson, v1Resource } from "./envelope.js";

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

// POST /v1/projects/:projectId/servers/:serverId/prompts/get
// Render a prompt with arguments and return the MCP GetPromptResult directly
// ({ description?, messages }). Wraps the same getPrompt core as
// /api/web/prompts/get.
prompts.post("/projects/:projectId/servers/:serverId/prompts/get", async (c) =>
  runV1ServerOp(
    c,
    promptsGetSchema,
    (manager, body) =>
      getPrompt(manager, {
        serverId: body.serverId,
        name: body.promptName,
        arguments: body.arguments,
      }),
    (ctx, result) => v1Resource(ctx, result)
  )
);

export default prompts;
