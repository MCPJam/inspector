import { Hono } from "hono";
import {
  promptsListSchema,
  promptsListMultiSchema,
  promptsGetSchema,
  withEphemeralConnection,
} from "./auth.js";
import {
  listPrompts,
  listPromptsMulti,
  getPrompt,
} from "../../utils/route-handlers.js";

const prompts = new Hono();

prompts.post("/list", async (c) =>
  withEphemeralConnection(c, promptsListSchema, (manager, body) =>
    listPrompts(manager, body),
  ),
);

prompts.post("/list-multi", async (c) =>
  withEphemeralConnection(c, promptsListMultiSchema, (manager, body) =>
    listPromptsMulti(manager, body),
  ),
);

prompts.post("/get", async (c) =>
  withEphemeralConnection(c, promptsGetSchema, (manager, body) =>
    getPrompt(manager, {
      serverId: body.serverId,
      name: body.promptName,
      arguments: body.arguments,
    }),
  ),
);

export default prompts;
