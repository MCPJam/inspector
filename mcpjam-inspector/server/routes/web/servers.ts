import { Hono } from "hono";
import { WEB_CONNECT_TIMEOUT_MS } from "../../config.js";
import {
  workspaceServerSchema,
  buildSingleServerOAuthTokens,
  createAuthorizedManager,
  withManager,
  handleRoute,
  assertBearerToken,
  readJsonBody,
  parseWithSchema,
} from "./auth.js";

const servers = new Hono();

servers.post("/validate", async (c) =>
  handleRoute(c, async () => {
    const bearerToken = assertBearerToken(c);
    const body = parseWithSchema(
      workspaceServerSchema,
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
        WEB_CONNECT_TIMEOUT_MS,
        oauthTokens,
      ),
      async (manager) => {
        await manager.getToolsForAiSdk([body.serverId]);
        return { success: true, status: "connected" };
      },
    );
  }),
);

export default servers;
