import { Hono } from "hono";
import "../../types/hono"; // Type extensions
import { exportServer } from "../../utils/export-helpers.js";

const exporter = new Hono();

// POST /export/server — export all server info as JSON
exporter.post("/server", async (c) => {
  try {
    const { serverId } = (await c.req.json()) as { serverId?: string };
    if (!serverId) {
      return c.json({ error: "serverId is required" }, 400);
    }

    const mcp = c.mcpClientManager;

    try {
      const result = await exportServer(mcp, serverId);
      return c.json(result);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (
        message.includes("not connected") ||
        message.includes("Unknown MCP server")
      ) {
        return c.json({ error: `Server '${serverId}' is not connected` }, 400);
      }
      throw error;
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return c.json({ error: msg }, 500);
  }
});

export default exporter;
