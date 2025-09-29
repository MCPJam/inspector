import { Hono } from "hono";
import { z } from "zod";
import { zodToJsonSchema } from "zod-to-json-schema";
import "../../types/hono"; // Type extensions

const exporter = new Hono();

// POST /export/server — export all server info as JSON
exporter.post("/server", async (c) => {
  try {
    const { serverId } = await c.req.json();
    if (!serverId) {
      return c.json({ error: "serverId is required" }, 400);
    }

    const mcp = c.mcpJamClientManager;
    const status = mcp.getConnectionStatus(serverId);
    if (status !== "connected") {
      return c.json({ error: `Server '${serverId}' is not connected` }, 400);
    }

    // Tools
    const flattenedTools = await mcp.getToolsetsForServer(serverId);
    const tools: Array<{
      name: string;
      description?: string;
      inputSchema: any;
      outputSchema?: any;
    }> = [];

    for (const [name, tool] of Object.entries(flattenedTools)) {
      let inputSchema = (tool as any).inputSchema;
      try {
        inputSchema = zodToJsonSchema(inputSchema as z.ZodType<any>);
      } catch {}
      tools.push({
        name,
        description: (tool as any).description,
        inputSchema,
        outputSchema: (tool as any).outputSchema,
      });
    }

    // Resources
    const resources = mcp.getResourcesForServer(serverId).map((r) => ({
      uri: r.uri,
      name: r.name,
      description: r.description,
      mimeType: r.mimeType,
    }));

    // Prompts
    const prompts = mcp.getPromptsForServer(serverId).map((p) => ({
      name: p.name,
      description: p.description,
      arguments: p.arguments,
    }));

    return c.json({
      serverId,
      exportedAt: new Date().toISOString(),
      tools,
      resources,
      prompts,
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return c.json({ error: msg }, 500);
  }
});

export default exporter;
