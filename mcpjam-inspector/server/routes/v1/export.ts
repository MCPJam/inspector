import { Hono } from "hono";
import { projectServerSchema } from "../web/auth.js";
import { exportServer } from "../../utils/export-helpers.js";
import { runV1ServerOp } from "./adapter.js";
import { v1Resource } from "./envelope.js";

const exporter = new Hono();

// POST /v1/projects/:projectId/servers/:serverId/export
// Export the full server snapshot (tools, resources, prompts) as JSON. Wraps the
// same exportServer core as /api/web/export/server.
exporter.post("/projects/:projectId/servers/:serverId/export", async (c) =>
  runV1ServerOp(
    c,
    projectServerSchema,
    (manager, body) => exportServer(manager, body.serverId),
    (ctx, result) => v1Resource(ctx, result)
  )
);

export default exporter;
