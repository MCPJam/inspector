import { Hono } from "hono";
import {
  resourcesListSchema,
  resourcesReadSchema,
  withEphemeralConnection,
} from "./auth.js";
import { runHostedDirectMrtrOperation } from "./mrtr-direct.js";
import { listResources, readResource } from "../../utils/route-handlers.js";

const resources = new Hono();

resources.post("/list", async (c) =>
  withEphemeralConnection(c, resourcesListSchema, (manager, body) =>
    // Hosted direct-ops read the server's live surface — never a cached body.
    listResources(manager, { ...body, cacheMode: "bypass" }),
  ),
);

resources.post("/read", async (c) =>
  // Hosted DIRECT resources/read (§12.3). Suspends to the continuation store on
  // an `input_required` round (returning a pending outcome) instead of blocking;
  // a normal read returns its `{ content }` body verbatim as before.
  runHostedDirectMrtrOperation(
    c,
    resourcesReadSchema,
    { method: "resources/read" },
    (manager, body, forwardLogMessages) => {
      forwardLogMessages(body.serverId);
      // Hosted direct-ops read the server's live surface — never a cached body.
      return readResource(manager, { ...body, cacheMode: "bypass" });
    },
  ),
);

export default resources;
