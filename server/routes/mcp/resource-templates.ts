import { Hono } from "hono";
import "../../types/hono"; // Type extensions

const resourceTemplates = new Hono();

// List resource templates endpoint
resourceTemplates.post("/list", async (c) => {
  try {
    const { serverId } = (await c.req.json()) as { serverId?: string };

    if (!serverId) {
      return c.json({ success: false, error: "serverId is required" }, 400);
    }
    const mcpClientManager = c.mcpClientManager;
    const { resourceTemplates: templates } =
      await mcpClientManager.listResourceTemplates(serverId);
    return c.json({ resourceTemplates: templates });
  } catch (error) {
    console.error("Error fetching resource templates:", error);
    return c.json(
      {
        success: false,
        error: error instanceof Error ? error.message : "Unknown error",
      },
      500,
    );
  }
});

// Read resource endpoint (using the resolved URI from a template)
resourceTemplates.post("/read", async (c) => {
  try {
    const { serverId, uri } = (await c.req.json()) as {
      serverId?: string;
      uri?: string;
    };

    if (!serverId) {
      return c.json({ success: false, error: "serverId is required" }, 400);
    }

    if (!uri) {
      return c.json(
        {
          success: false,
          error: "Resource URI is required",
        },
        400,
      );
    }

    const mcpClientManager = c.mcpClientManager;

    const content = await mcpClientManager.readResource(serverId, {
      uri,
    });

    return c.json({ content });
  } catch (error) {
    console.error("Error reading resource from template:", error);
    return c.json(
      {
        success: false,
        error: error instanceof Error ? error.message : "Unknown error",
      },
      500,
    );
  }
});

export default resourceTemplates;
