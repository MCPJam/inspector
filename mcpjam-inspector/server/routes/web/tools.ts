import { Hono } from "hono";
import { countToolsTokens } from "../../utils/tokenizer-helpers.js";
import { WEB_CALL_TIMEOUT_MS } from "../../config.js";
import {
  toolsListSchema,
  toolsExecuteSchema,
  buildSingleServerOAuthTokens,
  createAuthorizedManager,
  withManager,
  handleRoute,
  assertBearerToken,
  readJsonBody,
  parseWithSchema,
  ErrorCode,
  WebRouteError,
} from "./auth.js";

const tools = new Hono();

tools.post("/list", async (c) =>
  handleRoute(c, async () => {
    const bearerToken = assertBearerToken(c);
    const body = parseWithSchema(
      toolsListSchema,
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
        const result = await manager.listTools(
          body.serverId,
          body.cursor ? { cursor: body.cursor } : undefined,
        );
        const toolsMetadata = manager.getAllToolsMetadata(body.serverId);
        const tokenCount = body.modelId
          ? await countToolsTokens(result.tools, body.modelId)
          : undefined;

        return {
          ...result,
          toolsMetadata,
          tokenCount,
          nextCursor: result.nextCursor,
        };
      },
    );
  }),
);

tools.post("/execute", async (c) =>
  handleRoute(c, async () => {
    const bearerToken = assertBearerToken(c);
    const body = parseWithSchema(
      toolsExecuteSchema,
      await readJsonBody<unknown>(c),
    );

    if (body.taskOptions) {
      throw new WebRouteError(
        400,
        ErrorCode.FEATURE_NOT_SUPPORTED,
        "Task-augmented tool execution is not supported in hosted mode",
      );
    }

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
        const result = await manager.executeTool(
          body.serverId,
          body.toolName,
          body.parameters,
        );
        return {
          status: "completed",
          result,
        };
      },
    );
  }),
);

export default tools;
