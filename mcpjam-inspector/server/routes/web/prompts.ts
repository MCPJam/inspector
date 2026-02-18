import { Hono } from "hono";
import { WEB_CALL_TIMEOUT_MS } from "../../config.js";
import {
  promptsListSchema,
  promptsListMultiSchema,
  promptsGetSchema,
  buildSingleServerOAuthTokens,
  createAuthorizedManager,
  withManager,
  handleRoute,
  assertBearerToken,
  readJsonBody,
  parseWithSchema,
  parseErrorMessage,
} from "./auth.js";

const prompts = new Hono();

prompts.post("/list", async (c) =>
  handleRoute(c, async () => {
    const bearerToken = assertBearerToken(c);
    const body = parseWithSchema(
      promptsListSchema,
      await readJsonBody<unknown>(c),
    );

    const oauthTokens = buildSingleServerOAuthTokens(
      body.serverId,
      body.oauthAccessToken,
    );

    return withManager(
      createAuthorizedManager(
        bearerToken,
        body.workspaceId,
        [body.serverId],
        WEB_CALL_TIMEOUT_MS,
        oauthTokens,
      ),
      async (manager) => {
        const result = await manager.listPrompts(
          body.serverId,
          body.cursor ? { cursor: body.cursor } : undefined,
        );
        return {
          prompts: result.prompts ?? [],
          nextCursor: result.nextCursor,
        };
      },
    );
  }),
);

prompts.post("/list-multi", async (c) =>
  handleRoute(c, async () => {
    const bearerToken = assertBearerToken(c);
    const body = parseWithSchema(
      promptsListMultiSchema,
      await readJsonBody<unknown>(c),
    );

    return withManager(
      createAuthorizedManager(
        bearerToken,
        body.workspaceId,
        body.serverIds,
        WEB_CALL_TIMEOUT_MS,
        body.oauthTokens,
      ),
      async (manager) => {
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
      },
    );
  }),
);

prompts.post("/get", async (c) =>
  handleRoute(c, async () => {
    const bearerToken = assertBearerToken(c);
    const body = parseWithSchema(
      promptsGetSchema,
      await readJsonBody<unknown>(c),
    );

    const oauthTokens = buildSingleServerOAuthTokens(
      body.serverId,
      body.oauthAccessToken,
    );

    return withManager(
      createAuthorizedManager(
        bearerToken,
        body.workspaceId,
        [body.serverId],
        WEB_CALL_TIMEOUT_MS,
        oauthTokens,
      ),
      async (manager) => {
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
      },
    );
  }),
);

export default prompts;
