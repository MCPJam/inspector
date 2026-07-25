import { Hono } from "hono";
import {
  promptsListSchema,
  promptsListMultiSchema,
  promptsGetSchema,
  withEphemeralConnection,
} from "./auth.js";
import { runHostedDirectMrtrOperation } from "./mrtr-direct.js";
import {
  listPrompts,
  listPromptsMulti,
  getPrompt,
} from "../../utils/route-handlers.js";

const prompts = new Hono();

prompts.post("/list", async (c) =>
  withEphemeralConnection(c, promptsListSchema, (manager, body) =>
    // Hosted direct-ops read the server's live surface — never a cached body.
    listPrompts(manager, { ...body, cacheMode: "bypass" }),
  ),
);

prompts.post("/list-multi", async (c) =>
  withEphemeralConnection(c, promptsListMultiSchema, (manager, body) =>
    listPromptsMulti(manager, body),
  ),
);

prompts.post("/get", async (c) =>
  // Hosted DIRECT prompts/get (§12.3). Suspends to the continuation store on an
  // `input_required` round (returning a pending outcome) instead of blocking; a
  // normal get returns its `{ content }` body verbatim as before.
  runHostedDirectMrtrOperation(
    c,
    promptsGetSchema,
    { method: "prompts/get" },
    (manager, body, forwardLogMessages) => {
      forwardLogMessages(body.serverId);
      return getPrompt(manager, {
        serverId: body.serverId,
        name: body.promptName,
        arguments: body.arguments,
      });
    },
  ),
);

export default prompts;
