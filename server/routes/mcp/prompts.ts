import { Hono } from "hono";
import { ContentfulStatusCode } from "hono/utils/http-status";
import "../../types/hono"; // Type extensions

const prompts = new Hono();

// List prompts endpoint
prompts.post("/list", async (c) => {
  try {
    const { serverConfig } = await c.req.json();

    if (!serverConfig) {
      return c.json({ success: false, error: "serverConfig is required" }, 400);
    }

    const agent = c.get("mcpAgent");
    const serverId =
      (serverConfig as any).name || (serverConfig as any).id || "server";

    // Connect to server via centralized agent
    await agent.connectToServer(serverId, serverConfig);

    // Get prompts from agent's registry
    const allPrompts = agent.getAvailablePrompts();
    const normalizedServerId = serverId
      .toLowerCase()
      .replace(/[\s\-]+/g, "_")
      .replace(/[^a-z0-9_]/g, "");
    const serverPrompts = allPrompts.filter(
      (p) => p.serverId === normalizedServerId,
    );

    return c.json({ prompts: { [serverId]: serverPrompts } });
  } catch (error) {
    console.error("Error fetching prompts:", error);
    return c.json(
      {
        success: false,
        error: error instanceof Error ? error.message : "Unknown error",
      },
      500,
    );
  }
});

// Get prompt endpoint
prompts.post("/get", async (c) => {
  try {
    const { serverConfig, name, args } = await c.req.json();

    if (!serverConfig) {
      return c.json({ success: false, error: "serverConfig is required" }, 400);
    }

    if (!name) {
      return c.json(
        {
          success: false,
          error: "Prompt name is required",
        },
        400,
      );
    }

    const agent = c.get("mcpAgent");
    const serverId =
      (serverConfig as any).name || (serverConfig as any).id || "server";

    // Connect to server via centralized agent
    await agent.connectToServer(serverId, serverConfig);

    // Use agent to get prompt content
    const content = await agent.getPrompt(name, args || {});

    return c.json({ content });
  } catch (error) {
    console.error("Error getting prompt:", error);
    return c.json(
      {
        success: false,
        error: error instanceof Error ? error.message : "Unknown error",
      },
      500,
    );
  }
});

export default prompts;
