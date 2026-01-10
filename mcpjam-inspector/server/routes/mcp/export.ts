import { Hono } from "hono";
import "../../types/hono"; // Type extensions

const exporter = new Hono();

// POST /export/server — export all server info as JSON
exporter.post("/server", async (c) => {
  try {
    const { serverId } = (await c.req.json()) as { serverId?: string };
    if (!serverId) {
      return c.json({ error: "serverId is required" }, 400);
    }

    const mcp = c.mcpClientManager;

    let toolsResult: Awaited<ReturnType<typeof mcp.listTools>>;
    let resourcesResult: Awaited<ReturnType<typeof mcp.listResources>>;
    let promptsResult: Awaited<ReturnType<typeof mcp.listPrompts>>;

    try {
      [toolsResult, resourcesResult, promptsResult] = await Promise.all([
        mcp.listTools(serverId),
        mcp.listResources(serverId),
        mcp.listPrompts(serverId),
      ]);
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

    const tools = toolsResult.tools.map((tool) => ({
      name: tool.name,
      description: tool.description,
      inputSchema: tool.inputSchema,
      outputSchema: tool.outputSchema,
    }));

    const resources = resourcesResult.resources.map((resource) => ({
      uri: resource.uri,
      name: resource.name,
      description: resource.description,
      mimeType: resource.mimeType,
    }));

    const prompts = promptsResult.prompts.map((prompt) => ({
      name: prompt.name,
      description: prompt.description,
      arguments: prompt.arguments,
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
