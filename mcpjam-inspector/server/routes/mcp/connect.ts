import { connectServerWithReport } from "@mcpjam/sdk";
import type { ConnectContext, MCPServerConfig } from "@mcpjam/sdk";
import { Hono } from "hono";
import "../../types/hono"; // Type extensions
import { HOSTED_MODE } from "../../config";

const connect = new Hono();

connect.post("/", async (c) => {
  let body: {
    serverConfig?: MCPServerConfig;
    serverId?: string;
    oauthContext?: ConnectContext["oauth"];
  };

  try {
    body = (await c.req.json()) as {
      serverConfig?: MCPServerConfig;
      serverId?: string;
      oauthContext?: ConnectContext["oauth"];
    };
  } catch (error) {
    return c.json(
      {
        success: false,
        error: "Failed to parse request body",
        details: error instanceof Error ? error.message : "Unknown error",
      },
      400,
    );
  }

  try {
    const { serverConfig, serverId, oauthContext } = body;

    if (!serverConfig) {
      return c.json(
        {
          success: false,
          error: "serverConfig is required",
        },
        400,
      );
    }

    if (!serverId) {
      return c.json(
        {
          success: false,
          error: "serverId is required",
        },
        400,
      );
    }

    if (serverConfig.url) {
      if (typeof serverConfig.url === "string") {
        serverConfig.url = new URL(serverConfig.url);
      } else if (
        typeof serverConfig.url === "object" &&
        serverConfig.url.href
      ) {
        serverConfig.url = new URL(serverConfig.url.href);
      }
    }

    // Block STDIO connections in hosted mode (security: prevents RCE)
    if (HOSTED_MODE && serverConfig.command) {
      return c.json(
        {
          success: false,
          error: "STDIO transport is disabled in the web app",
        },
        403,
      );
    }

    // Enforce HTTPS in hosted mode
    if (HOSTED_MODE && serverConfig.url) {
      if (serverConfig.url.protocol !== "https:") {
        return c.json(
          {
            success: false,
            error:
              "HTTPS is required in the web app. Please use an https:// URL.",
          },
          400,
        );
      }
    }

    const mcpClientManager = c.mcpClientManager;
    const report = await connectServerWithReport({
      manager: mcpClientManager,
      serverId,
      config: serverConfig,
      target: serverId,
      disconnectBeforeConnect: true,
      ...(oauthContext ? { context: { oauth: oauthContext } } : {}),
    });

    if (!report.success) {
      try {
        await mcpClientManager.removeServer(serverId);
      } catch (cleanupError) {
        console.debug(
          `Failed to remove MCP server ${serverId} after connection failure`,
          cleanupError,
        );
      }
    }

    return c.json({
      success: report.success,
      status: report.status,
      report,
      initInfo: report.initInfo,
      ...(report.issue ? { error: report.issue.message } : {}),
    });
  } catch (error) {
    return c.json(
      {
        success: false,
        error: error instanceof Error ? error.message : "Failed to connect",
        details: error instanceof Error ? error.message : "Unknown error",
      },
      500,
    );
  }
});

export default connect;
