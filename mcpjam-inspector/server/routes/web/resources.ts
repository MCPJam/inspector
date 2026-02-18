import { Hono } from "hono";
import {
  resourcesListSchema,
  resourcesReadSchema,
  withEphemeralConnection,
} from "./auth.js";

const resources = new Hono();

resources.post("/list", async (c) =>
  withEphemeralConnection(c, resourcesListSchema, async (manager, body) => {
    const result = await manager.listResources(
      body.serverId,
      body.cursor ? { cursor: body.cursor } : undefined,
    );
    return {
      resources: result.resources ?? [],
      nextCursor: result.nextCursor,
    };
  }),
);

resources.post("/read", async (c) =>
  withEphemeralConnection(c, resourcesReadSchema, async (manager, body) => {
    const content = await manager.readResource(body.serverId, {
      uri: body.uri,
    });
    return { content };
  }),
);

export default resources;
