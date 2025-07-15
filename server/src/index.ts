#!/usr/bin/env node

import cors from "cors";
import { parseArgs } from "node:util";
import { parse as shellParseArgs } from "shell-quote";
import { createServer } from "node:net";

import { SseError } from "@modelcontextprotocol/sdk/client/sse.js";
import { getDefaultEnvironment } from "@modelcontextprotocol/sdk/client/stdio.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { SSEServerTransport } from "@modelcontextprotocol/sdk/server/sse.js";
import express from "express";
import { randomUUID } from "node:crypto";
import { DatabaseManager } from "./database/DatabaseManager.js";
import { createDatabaseRoutes } from "./database/routes.js";
import { getDatabaseConfig } from "./database/utils.js";
import { MCPProxyService, ConsoleLogger } from "./shared/index.js";
import type { ServerConfig } from "./shared/index.js";

const SSE_HEADERS_PASSTHROUGH = ["authorization"];
const STREAMABLE_HTTP_HEADERS_PASSTHROUGH = [
  "authorization",
  "mcp-session-id",
  "last-event-id",
];

const defaultEnvironment = {
  ...getDefaultEnvironment(),
  ...(process.env.MCP_ENV_VARS ? JSON.parse(process.env.MCP_ENV_VARS) : {}),
};

const serverConfigs = process.env.MCP_SERVER_CONFIGS
  ? JSON.parse(process.env.MCP_SERVER_CONFIGS)
  : null;

const { values } = parseArgs({
  args: process.argv.slice(2),
  options: {
    env: { type: "string", default: "" },
    args: { type: "string", default: "" },
  },
});

const app = express();
app.use(cors());
app.use((req, res, next) => {
  res.header("Access-Control-Expose-Headers", "mcp-session-id");
  next();
});

// Initialize database
let databaseManager: DatabaseManager | null = null;
const initializeDatabase = async () => {
  try {
    const dbConfig = getDatabaseConfig();
    databaseManager = new DatabaseManager(dbConfig);
    await databaseManager.initialize();

    // Add database routes after successful initialization
    app.use(
      "/api/db",
      express.json({ limit: "10mb" }), // JSON middleware only for database routes
      (req, res, next) => {
        if (!databaseManager) {
          res.status(503).json({
            success: false,
            error: "Database not available",
          });
          return;
        }
        next();
      },
      createDatabaseRoutes(databaseManager),
    );

    console.log("✅ Database API routes registered");
  } catch (error) {
    console.error("❌ Failed to initialize database:", error);
    // Don't exit the process - continue without database functionality
  }
};

// Initialize MCPProxyService
const mcpProxyService = new MCPProxyService({
  logger: new ConsoleLogger(),
  maxConnections: 50,
});

// Helper function to convert request query to ServerConfig
const createServerConfigFromRequest = (req: express.Request): ServerConfig => {
  const query = req.query;
  const transportType = query.transportType as string;

  const config: ServerConfig = {
    id: randomUUID(),
    type: transportType as "stdio" | "sse" | "streamable-http",
    name: `server-${Date.now()}`,
  };

  if (transportType === "stdio") {
    config.command = query.command as string;
    config.args = query.args
      ? (shellParseArgs(query.args as string) as string[])
      : undefined;

    // Safely parse env - only if it's a valid JSON string
    if (query.env) {
      try {
        config.env = JSON.parse(query.env as string);
      } catch (error) {
        console.warn(
          `Failed to parse env as JSON: ${query.env}, using empty object`,
        );
        config.env = {};
      }
    }
  } else if (transportType === "sse" || transportType === "streamable-http") {
    config.url = query.url as string;
  }

  return config;
};

// Helper function to extract headers for transport
const extractRequestHeaders = (
  req: express.Request,
): Record<string, string> => {
  const headers: Record<string, string> = {};
  const headersToPass =
    req.query.transportType === "sse"
      ? SSE_HEADERS_PASSTHROUGH
      : STREAMABLE_HTTP_HEADERS_PASSTHROUGH;

  for (const key of headersToPass) {
    const value = req.headers[key];
    if (value !== undefined) {
      headers[key] = Array.isArray(value) ? value[value.length - 1] : value;
    }
  }

  return headers;
};

app.get("/mcp", async (req, res) => {
  const sessionId = req.headers["mcp-session-id"] as string;
  console.log(`📥 Received GET message for sessionId ${sessionId}`);
  try {
    const transport = mcpProxyService.getWebAppTransport(
      sessionId,
    ) as StreamableHTTPServerTransport;
    if (!transport) {
      res.status(404).end("Session not found");
      return;
    } else {
      await transport.handleRequest(req, res);
    }
  } catch (error) {
    console.error("❌ Error in /mcp route:", error);
    res.status(500).json(error);
  }
});

app.post("/mcp", async (req, res) => {
  const sessionId = req.headers["mcp-session-id"] as string | undefined;
  console.log(`📥 Received POST message for sessionId ${sessionId}`);

  if (!sessionId) {
    try {
      console.log("🔄 New streamable-http connection");

      // Create server config and headers from request
      const serverConfig = createServerConfigFromRequest(req);
      const requestHeaders = extractRequestHeaders(req);

      try {
        // Use MCPProxyService to create the streamable HTTP connection
        const { sessionId: newSessionId, webAppTransport } =
          await mcpProxyService.createStreamableHTTPConnection(
            serverConfig,
            requestHeaders,
          );

        console.log(
          `✨ Connected MCP client to backing server transport for session ${newSessionId}`,
        );

        await webAppTransport.handleRequest(req, res, req.body);
      } catch (error) {
        if (error instanceof SseError && error.code === 401) {
          console.error(
            "🔒 Received 401 Unauthorized from MCP server:",
            error.message,
          );
          res.status(401).json(error);
          return;
        }
        throw error;
      }
    } catch (error) {
      console.error("❌ Error in /mcp POST route:", error);
      res.status(500).json(error);
    }
  } else {
    try {
      const transport = mcpProxyService.getWebAppTransport(
        sessionId,
      ) as StreamableHTTPServerTransport;
      if (!transport) {
        res.status(404).end("Transport not found for sessionId " + sessionId);
      } else {
        await transport.handleRequest(req, res);
      }
    } catch (error) {
      console.error("❌ Error in /mcp route:", error);
      res.status(500).json(error);
    }
  }
});

app.get("/stdio", async (req, res) => {
  try {
    console.log("🔄 New stdio/sse connection");

    // Create server config and headers from request
    const serverConfig = createServerConfigFromRequest(req);
    const requestHeaders = extractRequestHeaders(req);

    try {
      // Use MCPProxyService to create the SSE connection (handles STDIO stderr automatically)
      const { sessionId } = await mcpProxyService.createSSEConnection(
        serverConfig,
        res,
        requestHeaders,
      );

      console.log(
        `✨ Connected MCP client to backing server transport for session ${sessionId}`,
      );
    } catch (error) {
      if (error instanceof SseError && error.code === 401) {
        console.error(
          "🔒 Received 401 Unauthorized from MCP server:",
          error.message,
        );
        res.status(401).json(error);
        return;
      }

      throw error;
    }
  } catch (error) {
    console.error("❌ Error in /stdio route:", error);
    // Can't send a 500 response if headers already sent (which they are for SSE)
  }
});

app.get("/sse", async (req, res) => {
  try {
    console.log("🔄 New sse connection");

    // Create server config and headers from request
    const serverConfig = createServerConfigFromRequest(req);
    const requestHeaders = extractRequestHeaders(req);

    try {
      // Use MCPProxyService to create the SSE connection
      const { sessionId } = await mcpProxyService.createSSEConnection(
        serverConfig,
        res,
        requestHeaders,
      );

      console.log(
        `✨ Connected MCP client to backing server transport for session ${sessionId}`,
      );
    } catch (error) {
      if (error instanceof SseError && error.code === 401) {
        console.error(
          "🔒 Received 401 Unauthorized from MCP server:",
          error.message,
        );
        res.status(401).json(error);
        return;
      }

      throw error;
    }
  } catch (error) {
    console.error("❌ Error in /sse route:", error);
    // Can't send a 500 response if headers already sent (which they are for SSE)
  }
});

app.post("/message", async (req, res) => {
  try {
    const sessionId = req.query.sessionId;
    console.log(`📥 Received message for sessionId ${sessionId}`);

    const transport = mcpProxyService.getWebAppTransport(
      sessionId as string,
    ) as SSEServerTransport;
    if (!transport) {
      res.status(404).end("Session not found");
      return;
    }
    await transport.handlePostMessage(req, res);
  } catch (error) {
    console.error("❌ Error in /message route:", error);
    res.status(500).json(error);
  }
});

app.get("/health", (req, res) => {
  res.json({
    status: "ok",
  });
});

app.get("/config", (req, res) => {
  try {
    res.json({
      defaultEnvironment,
      defaultCommand: values.env,
      defaultArgs: values.args,
      serverConfigs,
    });
  } catch (error) {
    console.error("❌ Error in /config route:", error);
    res.status(500).json(error);
  }
});

// Database API routes - will be added after database initialization

// Function to find an available port
const findAvailablePort = async (startPort: number): Promise<number> => {
  return new Promise((resolve, reject) => {
    const server = createServer();

    server.listen(startPort, () => {
      const port = (server.address() as any)?.port;
      server.close(() => {
        resolve(port);
      });
    });

    server.on("error", (err: any) => {
      if (err.code === "EADDRINUSE") {
        // Port is in use, try the next one
        findAvailablePort(startPort + 1)
          .then(resolve)
          .catch(reject);
      } else {
        reject(err);
      }
    });
  });
};

const PORT = process.env.PORT || 6277;

// Store the actual running port
let actualPort: number;

// Add endpoint to get the actual running port
app.get("/port", (req, res) => {
  res.json({
    port: actualPort,
  });
});

// Start server with dynamic port finding
const startServer = async () => {
  try {
    // Initialize database first
    await initializeDatabase();

    const availablePort = await findAvailablePort(Number(PORT));
    actualPort = availablePort;

    const server = app.listen(availablePort);
    server.on("listening", () => {
      if (availablePort !== Number(PORT)) {
        console.log(
          `⚠️  Port ${PORT} was in use, using available port ${availablePort} instead`,
        );
      }

      console.log(
        `\x1b[32m%s\x1b[0m`,
        `⚙️ Proxy server listening on port ${availablePort}`,
      );
    });
    server.on("error", (err) => {
      console.error(`❌ Server error: ${err.message}`);
      process.exit(1);
    });

    // Graceful shutdown
    process.on("SIGINT", async () => {
      console.log("\n🔄 Shutting down server...");
      server.close();
      await mcpProxyService.closeAllConnections();
      if (databaseManager) {
        await databaseManager.close();
        console.log("✅ Database connection closed");
      }
      process.exit(0);
    });
  } catch (error) {
    console.error(`❌ Failed to start server: ${error}`);
    process.exit(1);
  }
};

startServer();
