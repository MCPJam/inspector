import { Hono } from "hono";
import "../../types/hono"; // Type extensions
import { logger } from "../../utils/logger";
import {
  listPrompts,
  listPromptsMulti,
  getPrompt,
} from "../../utils/route-handlers.js";

const prompts = new Hono();

// List prompts endpoint
prompts.post("/list", async (c) => {
  try {
    const body = (await c.req.json()) as { serverId?: string };
    if (!body.serverId) {
      return c.json({ success: false, error: "serverId is required" }, 400);
    }
    return c.json(
      await listPrompts(c.mcpClientManager, body as { serverId: string }),
    );
  } catch (error) {
    logger.error("Error fetching prompts", error, { serverId: "unknown" });
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
    const body = (await c.req.json()) as { serverIds?: string[] };
    if (!Array.isArray(body.serverIds) || body.serverIds.length === 0) {
      return c.json(
        { success: false, error: "serverIds must be a non-empty array" },
        400,
      );
    }

    const result = await listPromptsMulti(c.mcpClientManager, {
      serverIds: body.serverIds,
    });

    // Selective logging: suppress "Unknown MCP server" (expected during startup race conditions)
    if (result.errors) {
      for (const [serverId, msg] of Object.entries(
        result.errors as Record<string, string>,
      )) {
        if (!msg.includes("Unknown MCP server")) {
          logger.error(
            `Error fetching prompts for server ${serverId}`,
            new Error(msg),
            { serverId },
          );
        }
      }
    }

    return c.json(result);
  } catch (error) {
    logger.error("Error fetching batch prompts", error);
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
    const body = (await c.req.json()) as {
      serverId?: string;
      name?: string;
      args?: Record<string, unknown>;
    };
    if (!body.serverId) {
      return c.json({ success: false, error: "serverId is required" }, 400);
    }
    if (!body.name) {
      return c.json({ success: false, error: "Prompt name is required" }, 400);
    }

    return c.json(
      await getPrompt(c.mcpClientManager, {
        serverId: body.serverId,
        name: body.name,
        arguments: body.args,
      }),
    );
  } catch (error) {
    logger.error("Error getting prompt", error);
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
