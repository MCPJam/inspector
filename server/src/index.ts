#!/usr/bin/env node

import cors from "cors";
import { parseArgs } from "node:util";
import { parse as shellParseArgs } from "shell-quote";
import { createServer } from "node:net";
import fs from 'fs';
import path from 'path';

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
import { logToFile } from "./logger.js";

// Clear the logs directory on startup
const logsDir = path.join(process.cwd(), 'logs');
if (fs.existsSync(logsDir)) {
  fs.rmSync(logsDir, { recursive: true, force: true });
}
fs.mkdirSync(logsDir);

console.log('Backend running in:', process.cwd());

let lastLogFileName = 'inspector.log';

function getMcpServerLogFileName(req: express.Request) {
  const query = req.query;
  const transportType = query.transportType;
  if (transportType === "stdio") {
    const commandRaw = query.command || "unknown";
    const command = typeof commandRaw === 'string' ? commandRaw : Array.isArray(commandRaw) ? commandRaw.join(' ') : String(commandRaw);
    const argsRaw = query.args || "";
    const args = typeof argsRaw === 'string' ? argsRaw : Array.isArray(argsRaw) ? argsRaw.join(' ') : String(argsRaw);
    // Try to extract the actual MCP server name from the args
    let mcpName = command.split(/[\\/]/).pop()?.replace(/\W+/g, "-") || "unknown";
    // If using npx, look for the first non-flag arg that looks like a package name
    if (mcpName === "npx" && args) {
      const firstArg = args
        .split(/\s+/)
        .find((a: string) => !a.startsWith("-") && (a.startsWith("@") || /^[a-zA-Z0-9_-]+$/.test(a)));
      if (firstArg) {
        mcpName = firstArg.replace(/\W+/g, "-");
      }
    }
    return `mcp-server-${mcpName}.log`;
  } else if (transportType === "sse" || transportType === "streamable-http") {
    const url = query.url || "unknown";
    try {
      const host = new URL(url as string).hostname.replace(/\W+/g, "-");
      return `mcp-server-${host}.log`;
    } catch {
      return "mcp-server-unknown.log";
    }
  }
  return "mcp-server-unknown.log";
}

// Global error handlers
process.on('uncaughtException', (err) => {
  console.error('[uncaughtException]', err);
  console.log('[LOGGER] uncaughtException handler triggered');
  logToFile('error', 'uncaughtException', err.message, { stack: err.stack }, lastLogFileName);
});
process.on('unhandledRejection', (reason) => {
  const err = reason instanceof Error ? reason : new Error(String(reason));
  console.error('[unhandledRejection]', err);
  console.log('[LOGGER] unhandledRejection handler triggered');
  logToFile('error', 'unhandledRejection', err.message, { stack: err.stack }, lastLogFileName);
});

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

// Move log endpoints here to ensure they are not shadowed by static file serving
app.get('/logs/:logFile', (req, res) => {
  const logFile = req.params.logFile;
  const logsDir = path.join(process.cwd(), 'logs');
  const filePath = path.join(logsDir, logFile);

  // Debug print
  console.log('[LOG ENDPOINT] filePath:', filePath, 'exists:', fs.existsSync(filePath), 'headers:', req.headers);

  // Security: prevent path traversal
  if (!filePath.startsWith(logsDir)) {
    return res.status(400).send('Invalid log file');
  }

  // Disable caching
  res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate');
  res.setHeader('Pragma', 'no-cache');
  res.setHeader('Expires', '0');
  res.setHeader('Surrogate-Control', 'no-store');

  fs.readFile(filePath, 'utf8', (err, data) => {
    if (err) return res.status(200).type('text/plain').send(''); // Return empty string if not found
    res.type('text/plain').send(data);
  });
});

app.get('/logfile-name', (req, res) => {
  const logFileName = getMcpServerLogFileName(req);
  res.json({ logFileName });
});

const webAppTransports: Map<string, Transport> = new Map<string, Transport>(); // Transports by sessionId
const backingServerTransports = new Map<string, Transport>();

const createTransport = async (req: express.Request): Promise<Transport> => {
  const query = req.query;
  const transportType = query.transportType as string;
  const logFileName = getMcpServerLogFileName(req);

  if (transportType === "stdio") {
    const commandRaw = query.command || "unknown";
    const command = typeof commandRaw === 'string' ? commandRaw : Array.isArray(commandRaw) ? commandRaw.join(' ') : String(commandRaw);
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

    // Add error listener for async errors
    if (transport.stderr && typeof (transport.stderr as any).on === 'function') {
      (transport.stderr as any).on('data', (chunk: any) => {
        logToFile('error', 'stdio-stderr', chunk.toString(), {}, logFileName);
      });
    }
    if (typeof (transport as any).on === 'function') {
      (transport as any).on('error', (error: any) => {
        logToFile('error', 'stdio-transport', error.message, { stack: error.stack }, logFileName);
      });
    }

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

    // Add error listener for async errors
    if (typeof (transport as any).on === 'function') {
      (transport as any).on('error', (error: any) => {
        logToFile('error', 'sse-transport', error.message, { stack: error.stack }, logFileName);
      });
    }

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

    // Add error listener for async errors
    if (typeof (transport as any).on === 'function') {
      (transport as any).on('error', (error: any) => {
        logToFile('error', 'streamable-http-transport', error.message, { stack: error.stack }, logFileName);
      });
    }

    await transport.start();
    return transport;
  } else {
    console.error(`❌ Invalid transport type: ${transportType}`);
    logToFile('error', 'transport', `Invalid transport type: ${transportType}`, {}, logFileName);
    throw new Error("Invalid transport type specified");
  }
};

app.get("/mcp", async (req, res) => {
  const logFileName = getMcpServerLogFileName(req);
  try {
    const sessionId = req.headers["mcp-session-id"] as string;
    console.log(`📥 Received GET message for sessionId ${sessionId}`);
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
    const err = error instanceof Error ? error : new Error(String(error));
    console.log('[LOGGER] CATCH BLOCK REACHED', logFileName, err.message);
    logToFile("error", "/mcp route", err.message, { stack: err.stack }, logFileName);
    res.status(500).json({ error: err.message });
  }
});

app.post("/mcp", async (req, res) => {
  const logFileName = getMcpServerLogFileName(req);
  const sessionId = req.headers["mcp-session-id"] as string | undefined;
  console.log(`📥 Received POST message for sessionId ${sessionId}`);
  if (!sessionId) {
    try {
      console.log("🔄 New streamable-http connection");

      let backingServerTransport: Transport;
      try {
        backingServerTransport = await createTransport(req);
      } catch (error) {
        const err = error instanceof Error ? error : new Error(String(error));
        console.log('[LOGGER] CATCH BLOCK REACHED', logFileName, err.message);
        logToFile("error", "connection", err.message, { stack: err.stack }, logFileName);
        if (error instanceof SseError && error.code === 401) {
          console.error(
            "🔒 Received 401 Unauthorized from MCP server:",
            err.message,
          );
          res.status(401).json(err);
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
            logFileName: getMcpServerLogFileName(req),
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
    } catch (error) {
      const err = error instanceof Error ? error : new Error(String(error));
      console.log('[LOGGER] CATCH BLOCK REACHED', logFileName, err.message);
      logToFile("error", "/mcp POST route", err.message, { stack: err.stack }, logFileName);
      res.status(500).json({ error: err.message });
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
      const err = error instanceof Error ? error : new Error(String(error));
      console.log('[LOGGER] CATCH BLOCK REACHED', logFileName, err.message);
      logToFile("error", "/mcp route", err.message, { stack: err.stack }, logFileName);
      res.status(500).json({ error: err.message });
    }
  }
});

app.get("/stdio", async (req, res) => {
  const logFileName = getMcpServerLogFileName(req);
  lastLogFileName = logFileName;
  console.log('[LOGGER] /stdio endpoint hit', logFileName);
  logToFile('info', 'test', 'Direct endpoint logger test', undefined, logFileName);
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
        logFileName: getMcpServerLogFileName(req),
      });

      console.log(
        `✨ Connected MCP client to backing server transport for session ${sessionId}`,
      );
    } catch (error) {
      const err = error instanceof Error ? error : new Error(String(error));
      console.log('[LOGGER] CATCH BLOCK REACHED', logFileName, err.message);
      logToFile("error", "/stdio route", err.message, { stack: err.stack }, logFileName);
      if (error instanceof SseError && error.code === 401) {
        console.error(
          "🔒 Received 401 Unauthorized from MCP server:",
          err.message,
        );
        res.status(401).json(err);
        return;
      }
      throw error;
    }
  } catch (error) {
    const err = error instanceof Error ? error : new Error(String(error));
    console.log('[LOGGER] CATCH BLOCK REACHED', logFileName, err.message);
    // Can't send a 500 response if headers already sent (which they are for SSE)
  }
});

app.get("/sse", async (req, res) => {
  const logFileName = getMcpServerLogFileName(req);
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
        logFileName: getMcpServerLogFileName(req),
      });

      console.log(
        `✨ Connected MCP client to backing server transport for session ${sessionId}`,
      );
    } catch (error) {
      const err = error instanceof Error ? error : new Error(String(error));
      console.log('[LOGGER] CATCH BLOCK REACHED', logFileName, err.message);
      logToFile("error", "/sse route", err.message, { stack: err.stack }, logFileName);
      if (error instanceof SseError && error.code === 401) {
        console.error(
          "🔒 Received 401 Unauthorized from MCP server:",
          err.message,
        );
        res.status(401).json(err);
        return;
      }
      throw error;
    }
  } catch (error) {
    const err = error instanceof Error ? error : new Error(String(error));
    console.log('[LOGGER] CATCH BLOCK REACHED', logFileName, err.message);
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
    const err = error instanceof Error ? error : new Error(String(error));
    const logFileName = getMcpServerLogFileName(req);
    console.log('[LOGGER] CATCH BLOCK REACHED', logFileName, err.message);
    logToFile("error", "/message route", err.message, { stack: err.stack }, logFileName);
    res.status(500).json(err);
    throw error;
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
    const err = error instanceof Error ? error : new Error(String(error));
    const logFileName = getMcpServerLogFileName(req);
    console.log('[LOGGER] CATCH BLOCK REACHED', logFileName, err.message);
    logToFile("error", "/config route", err.message, { stack: err.stack }, logFileName);
    res.status(500).json(err);
    throw error;
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
      const errorObj = err instanceof Error ? err : new Error(String(err));
      const logFileName = 'inspector.log';
      console.log('[LOGGER] CATCH BLOCK REACHED', logFileName, errorObj.message);
      logToFile("error", "server", errorObj.message, { stack: errorObj.stack }, logFileName);
      console.error(`❌ Server error: ${errorObj.message}`);
      process.exit(1);
    });
  } catch (error) {
    const err = error instanceof Error ? error : new Error(String(error));
    const logFileName = 'inspector.log';
    console.log('[LOGGER] CATCH BLOCK REACHED', logFileName, err.message);
    logToFile("error", "server", err.message, { stack: err.stack }, logFileName);
    console.error(`❌ Failed to start server: ${err.message}`);
    process.exit(1);
  }
};

startServer();
