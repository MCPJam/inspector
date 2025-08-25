import { Hono } from "hono";
import "../../types/hono"; // Type extensions
import MCPJamClientManager from "../../services/mcpjam-client-manager";

const prompts = new Hono();

// List prompts endpoint
prompts.post("/list", async (c) => {
  try {
    const { serverId } = await c.req.json();

    if (!serverId) {
      return c.json({ success: false, error: "serverId is required" }, 400);
    }

    const mcpJamClientManager = c.get(
      "mcpJamClientManager",
    ) as MCPJamClientManager;

    // Get prompts for specific server
    const serverPrompts = mcpJamClientManager.getPromptsForServer(serverId);

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
    const { serverId, name, args } = await c.req.json();

    if (!serverId) {
      return c.json({ success: false, error: "serverId is required" }, 400);
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

    const mcpJamClientManager = c.get(
      "mcpJamClientManager",
    ) as MCPJamClientManager;

    // Get prompt content directly - servers are already connected
    const content = await mcpJamClientManager.getPrompt(
      name,
      serverId,
      args || {},
    );

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
