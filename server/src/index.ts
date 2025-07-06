#!/usr/bin/env node

import cors from "cors";
import { parseArgs } from "node:util";
import { parse as shellParseArgs } from "shell-quote";
import { createServer } from "node:net";
import { promises as fs } from "node:fs";
import { join as pathJoin } from "node:path";

import {
  SSEClientTransport,
  SseError,
} from "@modelcontextprotocol/sdk/client/sse.js";
import {
  StdioClientTransport,
  getDefaultEnvironment,
} from "@modelcontextprotocol/sdk/client/stdio.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { SSEServerTransport } from "@modelcontextprotocol/sdk/server/sse.js";
import { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import express from "express";
import { findActualExecutable } from "spawn-rx";
import mcpProxy from "./mcpProxy.js";
import { randomUUID } from "node:crypto";

const SSE_HEADERS_PASSTHROUGH = ["authorization"];
const STREAMABLE_HTTP_HEADERS_PASSTHROUGH = [
  "authorization",
  "mcp-session-id",
  "last-event-id",
];

// Add connection persistence constants
const CONNECTIONS_FILE_PATH = process.env.MCP_CONNECTIONS_FILE || pathJoin(process.cwd(), "mcp.json");
const CONNECTIONS_DIR = pathJoin(process.cwd(), "data");

// Ensure data directory exists
const ensureDataDirectory = async () => {
  try {
    await fs.mkdir(CONNECTIONS_DIR, { recursive: true });
  } catch (error) {
    console.warn("Could not create data directory:", error);
  }
};

// Load connections from file
const loadConnectionsFromFile = async () => {
  try {
    const data = await fs.readFile(CONNECTIONS_FILE_PATH, "utf8");
    return JSON.parse(data);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return null; // File doesn't exist
    }
    throw error;
  }
};

// Save connections to file
const saveConnectionsToFile = async (connections: any) => {
  try {
    await ensureDataDirectory();
    await fs.writeFile(CONNECTIONS_FILE_PATH, JSON.stringify(connections, null, 2), "utf8");
    return true;
  } catch (error) {
    console.error("Error saving connections:", error);
    throw error;
  }
};

const defaultEnvironment = {
  ...getDefaultEnvironment(),
  ...(process.env.MCP_ENV_VARS ? JSON.parse(process.env.MCP_ENV_VARS) : {}),
};

const { values } = parseArgs({
  args: process.argv.slice(2),
  options: {
    env: { type: "string", default: "" },
    args: { type: "string", default: "" },
  },
});

const app = express();
app.use(cors());
app.use(express.json()); // Add JSON parsing middleware
app.use((req, res, next) => {
  res.header("Access-Control-Expose-Headers", "mcp-session-id");
  next();
});

const webAppTransports: Map<string, Transport> = new Map<string, Transport>(); // Transports by sessionId
const backingServerTransports = new Map<string, Transport>();

const createTransport = async (req: express.Request): Promise<Transport> => {
  const query = req.query;

  const transportType = query.transportType as string;

  if (transportType === "stdio") {
    const command = query.command as string;
    const origArgs = shellParseArgs(query.args as string) as string[];
    const queryEnv = query.env ? JSON.parse(query.env as string) : {};
    const env = { ...process.env, ...defaultEnvironment, ...queryEnv };

    const { cmd, args } = findActualExecutable(command, origArgs);

    console.log(`🚀 Stdio transport: command=${cmd}, args=${args}`);

    const transport = new StdioClientTransport({
      command: cmd,
      args,
      env,
      stderr: "pipe",
    });

    await transport.start();
    return transport;
  } else if (transportType === "sse") {
    const url = query.url as string;
    const headers: HeadersInit = {
      Accept: "text/event-stream",
    };

    for (const key of SSE_HEADERS_PASSTHROUGH) {
      if (req.headers[key] === undefined) {
        continue;
      }

      const value = req.headers[key];
      headers[key] = Array.isArray(value) ? value[value.length - 1] : value;
    }

    const transport = new SSEClientTransport(new URL(url), {
      eventSourceInit: {
        fetch: (url, init) => fetch(url, { ...init, headers }),
      },
      requestInit: {
        headers,
      },
    });
    await transport.start();
    return transport;
  } else if (transportType === "streamable-http") {
    const headers: HeadersInit = {
      Accept: "text/event-stream, application/json",
    };

    for (const key of STREAMABLE_HTTP_HEADERS_PASSTHROUGH) {
      if (req.headers[key] === undefined) {
        continue;
      }

      const value = req.headers[key];
      headers[key] = Array.isArray(value) ? value[value.length - 1] : value;
    }

    const transport = new StreamableHTTPClientTransport(
      new URL(query.url as string),
      {
        requestInit: {
          headers,
        },
      },
    );
    await transport.start();
    return transport;
  } else {
    console.error(`❌ Invalid transport type: ${transportType}`);
    throw new Error("Invalid transport type specified");
  }
};

app.get("/mcp", async (req, res) => {
  const sessionId = req.headers["mcp-session-id"] as string;
  console.log(`📥 Received GET message for sessionId ${sessionId}`);
  try {
    const transport = webAppTransports.get(
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

      let backingServerTransport: Transport;
      try {
        backingServerTransport = await createTransport(req);
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

      const webAppTransport = new StreamableHTTPServerTransport({
        sessionIdGenerator: randomUUID,
        onsessioninitialized: (newSessionId) => {
          console.log(
            "✨ Created streamable web app transport " + newSessionId,
          );
          webAppTransports.set(newSessionId, webAppTransport);
          backingServerTransports.set(newSessionId, backingServerTransport);
          console.log(
            `✨ Connected MCP client to backing server transport for session ${newSessionId}`,
          );

          mcpProxy({
            transportToClient: webAppTransport,
            transportToServer: backingServerTransport,
          });

          webAppTransport.onclose = () => {
            console.log(
              `🧹 Cleaning up transports for session ${newSessionId}`,
            );
            webAppTransports.delete(newSessionId);
            backingServerTransports.delete(newSessionId);
          };
        },
      });

      await webAppTransport.start();

      await (webAppTransport as StreamableHTTPServerTransport).handleRequest(
        req,
        res,
        req.body,
      );
    } catch (error) {
      console.error("❌ Error in /mcp POST route:", error);
      res.status(500).json(error);
    }
  } else {
    try {
      const transport = webAppTransports.get(
        sessionId,
      ) as StreamableHTTPServerTransport;
      if (!transport) {
        res.status(404).end("Transport not found for sessionId " + sessionId);
      } else {
        await (transport as StreamableHTTPServerTransport).handleRequest(
          req,
          res,
        );
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
    const webAppTransport = new SSEServerTransport("/message", res);
    const sessionId = webAppTransport.sessionId;
    webAppTransports.set(sessionId, webAppTransport);

    try {
      const backingServerTransport = await createTransport(req);
      backingServerTransports.set(sessionId, backingServerTransport);

      webAppTransport.onclose = () => {
        console.log(`🧹 Cleaning up transports for session ${sessionId}`);
        webAppTransports.delete(sessionId);
        backingServerTransports.delete(sessionId);
      };

      await webAppTransport.start();
      if (backingServerTransport instanceof StdioClientTransport) {
        backingServerTransport.stderr!.on("data", (chunk) => {
          webAppTransport.send({
            jsonrpc: "2.0",
            method: "stderr",
            params: {
              data: chunk.toString(),
            },
          });
        });
      }

      mcpProxy({
        transportToClient: webAppTransport,
        transportToServer: backingServerTransport,
      });

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
    const webAppTransport = new SSEServerTransport("/message", res);
    const sessionId = webAppTransport.sessionId;
    webAppTransports.set(sessionId, webAppTransport);

    try {
      const backingServerTransport = await createTransport(req);
      backingServerTransports.set(sessionId, backingServerTransport);

      webAppTransport.onclose = () => {
        console.log(`🧹 Cleaning up transports for session ${sessionId}`);
        webAppTransports.delete(sessionId);
        backingServerTransports.delete(sessionId);
      };

      await webAppTransport.start();

      mcpProxy({
        transportToClient: webAppTransport,
        transportToServer: backingServerTransport,
      });

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

    const transport = webAppTransports.get(
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
    });
  } catch (error) {
    console.error("❌ Error in /config route:", error);
    res.status(500).json(error);
  }
});

// Add new connection persistence endpoints
app.get("/connections", async (req, res) => {
  try {
    const connections = await loadConnectionsFromFile();
    if (connections) {
      res.json({
        success: true,
        connections,
        source: "file",
        filePath: CONNECTIONS_FILE_PATH,
      });
    } else {
      res.json({
        success: true,
        connections: null,
        source: "none",
        filePath: CONNECTIONS_FILE_PATH,
      });
    }
  } catch (error) {
    console.error("Error loading connections:", error);
    res.status(500).json({
      success: false,
      error: "Failed to load connections from file",
      details: (error as Error).message,
      filePath: CONNECTIONS_FILE_PATH,
    });
  }
});

app.post("/connections", async (req, res) => {
  try {
    const { connections } = req.body;
    if (!connections || typeof connections !== "object") {
      return res.status(400).json({
        success: false,
        error: "Invalid connections data",
      });
    }

    await saveConnectionsToFile(connections);
    res.json({
      success: true,
      message: "Connections saved successfully",
      filePath: CONNECTIONS_FILE_PATH,
    });
  } catch (error) {
    console.error("Error saving connections:", error);
    res.status(500).json({
      success: false,
      error: "Failed to save connections to file",
      details: (error as Error).message,
      filePath: CONNECTIONS_FILE_PATH,
    });
  }
});

app.get("/connections/export", async (req, res) => {
  try {
    const connections = await loadConnectionsFromFile();
    if (!connections) {
      return res.status(404).json({
        success: false,
        error: "No connections found to export",
      });
    }

    const filename = `mcp-connections-${new Date().toISOString().split('T')[0]}.json`;
    
    res.setHeader('Content-Type', 'application/json');
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    res.send(JSON.stringify(connections, null, 2));
  } catch (error) {
    console.error("Error exporting connections:", error);
    res.status(500).json({
      success: false,
      error: "Failed to export connections",
      details: (error as Error).message,
    });
  }
});

app.post("/connections/import", async (req, res) => {
  try {
    const { connections, merge = false } = req.body;
    if (!connections || typeof connections !== "object") {
      return res.status(400).json({
        success: false,
        error: "Invalid connections data",
      });
    }

    let finalConnections = connections;
    
    if (merge) {
      const existingConnections = await loadConnectionsFromFile();
      if (existingConnections) {
        finalConnections = { ...existingConnections, ...connections };
      }
    }

    await saveConnectionsToFile(finalConnections);
    res.json({
      success: true,
      message: merge ? "Connections merged successfully" : "Connections imported successfully",
      filePath: CONNECTIONS_FILE_PATH,
    });
  } catch (error) {
    console.error("Error importing connections:", error);
    res.status(500).json({
      success: false,
      error: "Failed to import connections",
      details: (error as Error).message,
    });
  }
});

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
  } catch (error) {
    console.error(`❌ Failed to start server: ${error}`);
    process.exit(1);
  }
};

startServer();
