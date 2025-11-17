import { Hono } from "hono";
import "../../types/hono"; // Type extensions

const prompts = new Hono();

// List prompts endpoint
prompts.post("/list", async (c) => {
  try {
    const { serverId } = (await c.req.json()) as { serverId?: string };

    if (!serverId) {
      return c.json({ success: false, error: "serverId is required" }, 400);
    }

    const mcpClientManager = c.mcpClientManager;
    const { prompts } = await mcpClientManager.listPrompts(serverId);
    return c.json({ prompts });
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

// Batch list prompts endpoint
prompts.post("/list-multi", async (c) => {
  try {
    const { serverIds } = (await c.req.json()) as { serverIds?: string[] };

    if (!Array.isArray(serverIds) || serverIds.length === 0) {
      return c.json(
        { success: false, error: "serverIds must be a non-empty array" },
        400,
      );
    }

    const mcpClientManager = c.mcpClientManager;
    const promptsByServer: Record<string, unknown[]> = {};
    const errors: Record<string, string> = {};

    await Promise.all(
      serverIds.map(async (serverId) => {
        try {
          const { prompts } = await mcpClientManager.listPrompts(serverId);
          promptsByServer[serverId] = prompts ?? [];
        } catch (error) {
          console.error(
            `Error fetching prompts for server ${serverId}:`,
            error,
          );
          errors[serverId] =
            error instanceof Error ? error.message : "Unknown error";
          promptsByServer[serverId] = [];
        }
      }),
    );

    const payload: Record<string, unknown> = { prompts: promptsByServer };
    if (Object.keys(errors).length > 0) {
      payload.errors = errors;
    }

    return c.json(payload);
  } catch (error) {
    console.error("Error fetching batch prompts:", error);
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
    const { serverId, name, args } = (await c.req.json()) as {
      serverId?: string;
      name?: string;
      args?: Record<string, unknown>;
    };

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

    const mcpClientManager = c.mcpClientManager;

    const promptArguments = args
      ? Object.fromEntries(
          Object.entries(args).map(([key, value]) => [key, String(value)]),
        )
      : undefined;

    const content = await mcpClientManager.getPrompt(serverId, {
      name,
      arguments: promptArguments,
    });

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
