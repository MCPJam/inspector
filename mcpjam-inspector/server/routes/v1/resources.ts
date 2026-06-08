import { Hono } from "hono";
import { resourcesListSchema, resourcesReadSchema } from "../web/auth.js";
import { listResources, readResource } from "../../utils/route-handlers.js";
import { runV1ServerOp } from "./adapter.js";
import { v1PageJson, v1Resource } from "./envelope.js";

const resources = new Hono();

// POST /v1/projects/:projectId/servers/:serverId/resources
// List the server's resources. Wraps the same listResources core as
// /api/web/resources/list.
resources.post("/projects/:projectId/servers/:serverId/resources", async (c) =>
  runV1ServerOp(
    c,
    resourcesListSchema,
    (manager, body) => listResources(manager, body),
    (ctx, result: { resources?: unknown[]; nextCursor?: string }) =>
      v1PageJson(ctx, result.resources ?? [], result.nextCursor)
  )
);

// POST /v1/projects/:projectId/servers/:serverId/resources/read
// Read one resource by uri (required in the JSON body). Wraps the same
// readResource core as /api/web/resources/read; returns the contents directly.
resources.post(
  "/projects/:projectId/servers/:serverId/resources/read",
  async (c) =>
    runV1ServerOp(
      c,
      resourcesReadSchema,
      (manager, body) => readResource(manager, body),
      (ctx, result) => v1Resource(ctx, result)
    )
);

export default resources;
