import { Hono } from "hono";
import chatgptApps from "./chatgpt-apps";
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

// Canonical mount point for widget upload/download. The chatgpt-apps router
// also mounts widgetFiles internally so legacy `/chatgpt-apps/upload-file`
// and `/chatgpt-apps/file/:fileId` URLs keep working during the
// triple-renderer consolidation. Drop the alias in Phase 4 once the legacy
// ChatGPTAppRenderer path is deleted.
apps.route("/files", widgetFiles);

apps.route("/chatgpt-apps", chatgptApps);
apps.route("/mcp-apps", mcpApps);

export default apps;
