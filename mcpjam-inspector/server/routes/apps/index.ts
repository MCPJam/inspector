import { Hono } from "hono";
import mcpApps from "./mcp-apps";
import widgetFiles from "./shared/widget-files";

const apps = new Hono();

apps.get("/health", (c) =>
  c.json({
    service: "Apps API",
    status: "ready",
    timestamp: new Date().toISOString(),
  }),
);

apps.route("/files", widgetFiles);
apps.route("/mcp-apps", mcpApps);

export default apps;
