import { Hono } from "hono";
import {
  promptsListSchema,
  promptsListMultiSchema,
  promptsGetSchema,
  withEphemeralConnection,
  parseErrorMessage,
} from "./auth.js";

const prompts = new Hono();

prompts.post("/list", async (c) =>
  withEphemeralConnection(c, promptsListSchema, async (manager, body) => {
    const result = await manager.listPrompts(
      body.serverId,
      body.cursor ? { cursor: body.cursor } : undefined,
    );
    return {
      prompts: result.prompts ?? [],
      nextCursor: result.nextCursor,
    };
  }),
);

prompts.post("/list-multi", async (c) =>
  withEphemeralConnection(c, promptsListMultiSchema, async (manager, body) => {
    const promptsByServer: Record<string, unknown[]> = {};
    const errors: Record<string, string> = {};

    await Promise.all(
      body.serverIds.map(async (serverId) => {
        try {
          const { prompts } = await manager.listPrompts(serverId);
          promptsByServer[serverId] = prompts ?? [];
        } catch (error) {
          const errorMessage = parseErrorMessage(error);
          errors[serverId] = errorMessage;
          promptsByServer[serverId] = [];
        }
      }),
    );

    const payload: Record<string, unknown> = {
      prompts: promptsByServer,
    };
    if (Object.keys(errors).length > 0) {
      payload.errors = errors;
    }
    return payload;
  }),
);

prompts.post("/get", async (c) =>
  withEphemeralConnection(c, promptsGetSchema, async (manager, body) => {
    const promptArguments = body.arguments
      ? Object.fromEntries(
          Object.entries(body.arguments).map(([key, value]) => [
            key,
            String(value),
          ]),
        )
      : undefined;

    const content = await manager.getPrompt(body.serverId, {
      name: body.promptName,
      arguments: promptArguments,
    });
    return { content };
  }),
);

export default prompts;
