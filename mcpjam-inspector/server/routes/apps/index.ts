import { Hono } from "hono";
import chatgptApps from "./chatgpt-apps";
import mcpApps from "./mcp-apps";

const apps = new Hono();

apps.get("/health", (c) =>
  c.json({
    service: "Apps API",
    status: "ready",
    timestamp: new Date().toISOString(),
  }),
);

apps.route("/chatgpt-apps", chatgptApps);
apps.route("/mcp-apps", mcpApps);

export default apps;
