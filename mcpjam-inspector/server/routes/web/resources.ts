import { Hono } from "hono";
import { WEB_CALL_TIMEOUT_MS } from "../../config.js";
import {
  resourcesListSchema,
  resourcesReadSchema,
  buildSingleServerOAuthTokens,
  createAuthorizedManager,
  withManager,
  handleRoute,
  assertBearerToken,
  readJsonBody,
  parseWithSchema,
} from "./auth.js";

const resources = new Hono();

resources.post("/list", async (c) =>
  handleRoute(c, async () => {
    const bearerToken = assertBearerToken(c);
    const body = parseWithSchema(
      resourcesListSchema,
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
        const result = await manager.listResources(
          body.serverId,
          body.cursor ? { cursor: body.cursor } : undefined,
        );
        return {
          resources: result.resources ?? [],
          nextCursor: result.nextCursor,
        };
      },
    );
  }),
);

resources.post("/read", async (c) =>
  handleRoute(c, async () => {
    const bearerToken = assertBearerToken(c);
    const body = parseWithSchema(
      resourcesReadSchema,
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
        const content = await manager.readResource(body.serverId, {
          uri: body.uri,
        });
        return { content };
      },
    );
  }),
);

export default resources;
