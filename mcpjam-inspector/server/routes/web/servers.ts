import { Hono } from "hono";
import { WEB_CONNECT_TIMEOUT_MS } from "../../config.js";
import {
  workspaceServerSchema,
  withEphemeralConnection,
  handleRoute,
  authorizeServer,
  assertBearerToken,
  readJsonBody,
  parseWithSchema,
} from "./auth.js";

const servers = new Hono();

servers.post("/validate", async (c) =>
  withEphemeralConnection(
    c,
    workspaceServerSchema,
    async (manager, body) => {
      await manager.getToolsForAiSdk([body.serverId]);
      const initInfo = manager.getInitializationInfo(body.serverId);
      return { success: true, status: "connected", initInfo: initInfo ?? null };
    },
    { timeoutMs: WEB_CONNECT_TIMEOUT_MS },
  ),
);

servers.post("/check-oauth", async (c) =>
  handleRoute(c, async () => {
    const bearerToken = assertBearerToken(c);
    const body = parseWithSchema(
      workspaceServerSchema,
      await readJsonBody<unknown>(c),
    );
    const auth = await authorizeServer(
      bearerToken,
      body.workspaceId,
      body.serverId,
      {
        accessScope: body.accessScope,
        shareToken: body.shareToken,
      },
    );
    return {
      useOAuth: auth.serverConfig.useOAuth ?? false,
      serverUrl: auth.serverConfig.url ?? null,
    };
  }),
);

export default servers;
