import { Hono } from "hono";
import type { LoggingLevel } from "@modelcontextprotocol/client";
import "../../types/hono"; // Extend Hono context
import { logger } from "../../utils/logger";

type SetLogLevelRequest = {
  serverId?: string;
  // `null` is an explicit opt-out signal for the modern per-request
  // mechanism (absence of the level ⇒ absence of the `_meta` key on the
  // wire). Omitting the field entirely is a validation error, same as
  // before.
  level?: LoggingLevel | null;
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
  let serverId: string | undefined;
  let level: LoggingLevel | null | undefined;
  try {
    ({ serverId, level } = (await c.req.json()) as SetLogLevelRequest);

    if (!serverId || level === undefined) {
      return c.json(
        { success: false, error: "serverId and level are required" },
        400,
      );
    }

    if (level !== null && !VALID_LEVELS.includes(level)) {
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

    // Era-aware dispatch. `getLoggingMechanism` is the same helper the
    // client UI reads to decide which control to render, so the route and
    // the UI can never disagree about which channel is live for a server:
    //   - "per-request-meta" (modern, 2026-07-28): the level rides on every
    //     subsequent request's `_meta` — no RPC is sent here. `level: null`
    //     opts out (clears the stored level; the `_meta` key goes absent).
    //   - "setLevel" (legacy): unchanged — a single `logging/setLevel` RPC
    //     on connect. `null` is not meaningful here (there's no persistent
    //     per-request state to clear) and is rejected.
    //   - "none": no live client, or the server doesn't advertise logging.
    const mechanism = mcpClientManager.getLoggingMechanism(serverId);

    if (mechanism === "none") {
      return c.json(
        {
          success: false,
          error: `Server "${serverId}" does not support logging`,
        },
        400,
      );
    }

    if (mechanism === "per-request-meta") {
      mcpClientManager.setPerRequestLogLevel(
        serverId,
        level === null ? undefined : level,
      );
    } else {
      if (level === null) {
        return c.json(
          {
            success: false,
            error: `Server "${serverId}" uses the legacy "logging/setLevel" mechanism, which does not support opting out`,
          },
          400,
        );
      }
      await mcpClientManager.setLoggingLevel(serverId, level);
    }

    return c.json({
      success: true,
      serverId,
      level,
      mechanism,
      message:
        level === null
          ? `Logging opt-out set for server "${serverId}"`
          : `Logging level set to "${level}" for server "${serverId}" (${mechanism})`,
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
