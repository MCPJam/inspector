import { randomUUID } from "node:crypto";
import { createServer } from "node:http";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { z } from "zod";

const PORT = Number(process.env.PORT ?? "3101");
const UI_RESOURCE_URI = "ui://widgets/status-dashboard.html";
const UI_RESOURCE_MIME_TYPE = "text/html;profile=mcp-app";
const DASHBOARD_HTML = `<!DOCTYPE html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <title>Status Dashboard</title>
  </head>
  <body>
    <main>
      <h1>Status Dashboard</h1>
      <p>Service health is green.</p>
    </main>
  </body>
</html>`;

function createMcpServer() {
  const server = new McpServer(
    {
      name: "basic-conformance-example",
      version: "1.0.0",
    },
    {
      capabilities: {
        tools: {},
        prompts: {},
        resources: {},
      },
    },
  );

  server.registerTool(
    "get_status",
    {
      title: "Get Status",
      description: "Return a plain-text status summary.",
      inputSchema: z.object({}),
    },
    async () => ({
      content: [
        {
          type: "text",
          text: "Service health is green.",
        },
      ],
    }),
  );

  server.registerTool(
    "open_status_dashboard",
    {
      title: "Open Status Dashboard",
      description: "Return status data and advertise an MCP Apps dashboard.",
      inputSchema: z.object({}),
      _meta: {
        ui: {
          resourceUri: UI_RESOURCE_URI,
          visibility: ["model", "app"],
        },
      },
    },
    async () => ({
      content: [
        {
          type: "text",
          text: "Dashboard ready.",
        },
      ],
      structuredContent: {
        status: "green",
        incidentsOpen: 0,
      },
    }),
  );

  server.registerResource(
    "status-summary",
    "resource://status-summary",
    {
      title: "Status Summary",
      description: "Plain-text service summary.",
      mimeType: "text/plain",
    },
    async () => ({
      contents: [
        {
          uri: "resource://status-summary",
          mimeType: "text/plain",
          text: "Service health is green.",
        },
      ],
    }),
  );

  server.registerResource(
    "status-dashboard",
    UI_RESOURCE_URI,
    {
      title: "Status Dashboard",
      description: "HTML dashboard for MCP Apps conformance.",
      mimeType: UI_RESOURCE_MIME_TYPE,
    },
    async () => ({
      contents: [
        {
          uri: UI_RESOURCE_URI,
          mimeType: UI_RESOURCE_MIME_TYPE,
          text: DASHBOARD_HTML,
          _meta: {
            ui: {
              csp: {
                connectDomains: [],
                resourceDomains: [],
              },
              permissions: {
                geolocation: {},
              },
              prefersBorder: true,
            },
          },
        },
      ],
    }),
  );

  server.registerPrompt(
    "status_prompt",
    {
      title: "Status Prompt",
      description: "Ask the model to summarize current service health.",
    },
    async () => ({
      messages: [
        {
          role: "user",
          content: {
            type: "text",
            text: "Summarize the current service health and mention the dashboard.",
          },
        },
      ],
    }),
  );

  return server;
}

const sessions = new Map();

const httpServer = createServer(async (req, res) => {
  const url = new URL(req.url ?? "/", `http://127.0.0.1:${PORT}`);

  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, DELETE, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, mcp-session-id");
  res.setHeader("Access-Control-Expose-Headers", "mcp-session-id");

  if (req.method === "OPTIONS") {
    res.writeHead(204);
    res.end();
    return;
  }

  if (url.pathname === "/healthz") {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ status: "ok" }));
    return;
  }

  if (url.pathname !== "/mcp") {
    res.writeHead(404, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "Not found" }));
    return;
  }

  const sessionId = req.headers["mcp-session-id"];
  const activeSessionId = Array.isArray(sessionId) ? sessionId[0] : sessionId;

  if (activeSessionId && sessions.has(activeSessionId)) {
    await sessions.get(activeSessionId).handleRequest(req, res);
    return;
  }

  if (req.method === "POST") {
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: () => randomUUID(),
      onsessioninitialized: (id) => {
        sessions.set(id, transport);
      },
    });

    transport.onclose = () => {
      if (transport.sessionId) {
        sessions.delete(transport.sessionId);
      }
    };

    await createMcpServer().connect(transport);
    await transport.handleRequest(req, res);
    return;
  }

  res.writeHead(405, { "Content-Type": "application/json" });
  res.end(JSON.stringify({ error: "Method not allowed" }));
});

const shutdown = () => {
  httpServer.close(() => {
    process.exit(0);
  });
};

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);

httpServer.listen(PORT, "127.0.0.1", () => {
  console.error(`[basic-conformance] ready on http://127.0.0.1:${PORT}/mcp`);
});
