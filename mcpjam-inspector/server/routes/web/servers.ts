import { Hono } from "hono";
import { WEB_CONNECT_TIMEOUT_MS } from "../../config.js";
import { workspaceServerSchema, withEphemeralConnection } from "./auth.js";

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

export default servers;
