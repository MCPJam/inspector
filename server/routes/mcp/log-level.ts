import { Hono } from "hono";
import type { LoggingLevel } from "@modelcontextprotocol/sdk/types.js";
import "../../types/hono"; // Extend Hono context
import { logger } from "../../utils/logger";

type SetLogLevelRequest = {
  serverId?: string;
  level?: LoggingLevel;
};

const VALID_LEVELS: LoggingLevel[] = [
  "debug",
  "info",
  "notice",
  "warning",
  "error",
  "critical",
  "alert",
  "emergency",
];

const logLevel = new Hono();

logLevel.post("/", async (c) => {
  try {
    const { serverId, level } = (await c.req.json()) as SetLogLevelRequest;

    if (!serverId || !level) {
      return c.json(
        { success: false, error: "serverId and level are required" },
        400,
      );
    }

    if (!VALID_LEVELS.includes(level)) {
      return c.json(
        {
          success: false,
          error: `Invalid logging level "${level}". Expected one of: ${VALID_LEVELS.join(", ")}`,
        },
        400,
      );
    }

    const mcpClientManager = c.mcpClientManager;
    if (!mcpClientManager.hasServer(serverId)) {
      return c.json(
        {
          success: false,
          error: `Server "${serverId}" is not registered`,
        },
        404,
      );
    }

    await mcpClientManager.setLoggingLevel(serverId, level);

    return c.json({
      success: true,
      serverId,
      level,
      message: `Logging level set to "${level}" for server "${serverId}"`,
    });
  } catch (error) {
    logger.error("Error setting MCP server logging level", error, {
      serverId,
      level,
    });
    return c.json(
      {
        success: false,
        error: error instanceof Error ? error.message : "Unknown error",
      },
      500,
    );
  }
});

export default logLevel;
