import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { createServer, IncomingMessage, ServerResponse } from "http";
import { readFileSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));

let coffeeCount: number = 0;

const server = new McpServer({
  name: "coffee-shop",
  version: "1.0.0"
});

// Widget HTML - built with React and bundled by Vite into a single file.
// The client injects `window.openai` into the iframe, allowing the widget to
// communicate with the chat and invoke tools exposed by your MCP server.
const WIDGET_HTML: string = readFileSync(
  join(__dirname, "dist", "coffee-widget.html"),
  "utf-8"
);

server.registerResource(
  "coffee-widget",
  "ui://widget/coffee.html",
  {
    description: "Coffee Shop widget showing your coffee collection"
  },
  async () => ({
    contents: [{
      uri: "ui://widget/coffee.html",
      mimeType: "text/html+skybridge",
      text: WIDGET_HTML,
      _meta: {
        "openai/widgetPrefersBorder": true,
        "openai/widgetCSP": {
          connect_domains: [],
          redirect_domains: ["https://www.mcpjam.com"]
        }
      }
    }]
  })
);

server.registerTool(
  "orderCoffee",
  {
    title: "Order Coffee",
    description: "Order a coffee to add to your collection. Use this when the user wants to order, buy, or get a coffee.",
    _meta: {
      "openai/outputTemplate": "ui://widget/coffee.html",
      "openai/widgetAccessible": true,
      "openai/toolInvocation/invoking": "Brewing coffee...",
      "openai/toolInvocation/invoked": "Coffee ready!"
    }
  },
  async () => {
    if (coffeeCount >= 10) {
      return {
        structuredContent: {
          coffeeCount: coffeeCount,
          message: "Sorry, you already have 10 coffees! Drink some first."
        },
        content: [{
          type: "text" as const,
          text: `The coffee shop is at capacity! You have ${coffeeCount} coffees. Drink some before ordering more.`
        }]
      };
    }

    coffeeCount++;

    return {
      structuredContent: {
        coffeeCount: coffeeCount,
        message: "Here's your coffee! ☕️"
      },
      content: [{
        type: "text" as const,
        text: `Ordered a coffee! You now have ${coffeeCount} coffee${coffeeCount === 1 ? '' : 's'}.`
      }]
    };
  }
);

server.registerTool(
  "drinkCoffee",
  {
    title: "Drink Coffee",
    description: "Drink a coffee from your collection. Use this when the user wants to drink, consume, or have a coffee.",
    _meta: {
      "openai/outputTemplate": "ui://widget/coffee.html",
      "openai/widgetAccessible": true,
      "openai/toolInvocation/invoking": "Drinking coffee...",
      "openai/toolInvocation/invoked": "Refreshing!"
    }
  },
  async () => {
    if (coffeeCount <= 0) {
      return {
        structuredContent: {
          coffeeCount: coffeeCount,
          message: "No coffees to drink! Order some first."
        },
        content: [{
          type: "text" as const,
          text: "You don't have any coffees to drink. Order some first!"
        }]
      };
    }

    coffeeCount--;

    return {
      structuredContent: {
        coffeeCount: coffeeCount,
        message: "Ahh, that was refreshing! ☕️"
      },
      content: [{
        type: "text" as const,
        text: `Enjoyed a coffee! You have ${coffeeCount} coffee${coffeeCount === 1 ? '' : 's'} left.`
      }]
    };
  }
);

const PORT: number = Number(process.env.PORT) || 8787;

const sessions = new Map<string, StreamableHTTPServerTransport>();

const httpServer = createServer(async (req: IncomingMessage, res: ServerResponse) => {
  const url = new URL(req.url!, `http://localhost:${PORT}`);

  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, DELETE, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, mcp-session-id");
  res.setHeader("Access-Control-Expose-Headers", "mcp-session-id");

  if (req.method === "OPTIONS") {
    res.writeHead(204);
    res.end();
    return;
  }

  if (url.pathname === "/" && req.method === "GET") {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({
      status: "ok",
      app: "Coffee Shop",
      coffeeCount: coffeeCount
    }));
    return;
  }

  if (url.pathname === "/mcp") {
    const sessionId = req.headers["mcp-session-id"] as string | undefined;

    if (sessionId && sessions.has(sessionId)) {
      const transport = sessions.get(sessionId)!;
      await transport.handleRequest(req, res);
      return;
    }

    if (req.method === "POST") {
      const transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: () => crypto.randomUUID(),
        onsessioninitialized: (id: string) => {
          sessions.set(id, transport);
        }
      });

      transport.onclose = () => {
        const id = transport.sessionId;
        if (id) sessions.delete(id);
      };

      await server.connect(transport);

      await transport.handleRequest(req, res);
      return;
    }

    res.writeHead(405, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "Method not allowed" }));
    return;
  }

  res.writeHead(404, { "Content-Type": "application/json" });
  res.end(JSON.stringify({ error: "Not found" }));
});

httpServer.listen(PORT, () => {
  console.log("");
  console.log("☕️ ============================================");
  console.log("☕️  COFFEE SHOP MCP SERVER");
  console.log("☕️ ============================================");
  console.log("");
  console.log(`   Server running at: http://localhost:${PORT}`);
  console.log(`   MCP endpoint:      http://localhost:${PORT}/mcp`);
  console.log("");
  console.log("   To test with MCPJam Inspector:");
  console.log("   1. Go to https://mcpjam.com/inspector");
  console.log(`   2. Enter URL: http://localhost:${PORT}/mcp`);
  console.log("");
  console.log("   To connect to ChatGPT:");
  console.log("   Click 'Create ngrok tunnel' with a connected server,");
  console.log("   then use the tunnel URL as your connector endpoint.");
  console.log("");
  console.log("☕️ ============================================");
  console.log("");
});
