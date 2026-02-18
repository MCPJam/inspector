import { Hono } from "hono";
import {
  resourcesListSchema,
  resourcesReadSchema,
  withEphemeralConnection,
} from "./auth.js";
import { listResources, readResource } from "../../utils/route-handlers.js";

const resources = new Hono();

resources.post("/list", async (c) =>
  withEphemeralConnection(c, resourcesListSchema, (manager, body) =>
    listResources(manager, body),
  ),
);

resources.post("/read", async (c) =>
  withEphemeralConnection(c, resourcesReadSchema, (manager, body) =>
    readResource(manager, body),
  ),
);

export default resources;
