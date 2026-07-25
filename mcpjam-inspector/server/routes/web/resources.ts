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
    // Hosted direct-ops read the server's live surface — never a cached body.
    listResources(manager, { ...body, cacheMode: "bypass" }),
  ),
);

resources.post("/read", async (c) =>
  withEphemeralConnection(
    c,
    resourcesReadSchema,
    (manager, body, forwardLogMessages) => {
      forwardLogMessages(body.serverId);
      // Hosted direct-ops read the server's live surface — never a cached body.
      return readResource(manager, { ...body, cacheMode: "bypass" });
    },
  ),
);

export default resources;
