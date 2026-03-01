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
      return { success: true, status: "connected" };
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

servers.post("/init-info", async (c) =>
  withEphemeralConnection(c, workspaceServerSchema, async (manager, body) => {
    // Force connection so init info is populated from the MCP handshake
    await manager.getToolsForAiSdk([body.serverId]);
    const initInfo = manager.getInitializationInfo(body.serverId);
    return { success: true, initInfo: initInfo ?? null };
  }),
);

export default servers;
