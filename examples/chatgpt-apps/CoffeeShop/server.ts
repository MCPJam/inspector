import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { createServer, IncomingMessage, ServerResponse } from "http";

let coffeeCount: number = 0;

const server = new McpServer({
  name: "coffee-shop",
  version: "1.0.0"
});

// Widget HTML - displayed inside an iframe in a client when a tool is called.
// The client injects `window.openai` into the iframe, allowing the widget to
// communicate with the chat and invoke tools exposed by your MCP server.
const WIDGET_HTML: string = `
<!DOCTYPE html>
<html>
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <script src="https://cdn.tailwindcss.com"></script>
  <script>
    tailwind.config = {
      theme: {
        extend: {
          colors: {
            coffee: '#8B4513',
            'coffee-dark': '#6d3610',
            cream: '#F5E6D3',
          }
        }
      }
    }
  </script>
</head>
<body class="bg-cream min-h-screen flex justify-center items-center p-5">
  <div class="w-full max-w-[400px]">
    <div class="flex items-center gap-3 pb-4 border-b border-gray-200 mb-6">
      <span class="text-3xl">☕️</span>
      <span class="text-2xl font-semibold text-gray-900">Coffee Shop</span>
    </div>

    <div class="grid grid-cols-5 gap-2 mb-6" id="coffeeGrid"></div>

    <div class="flex gap-3">
      <button id="orderBtn" class="flex-1 py-3.5 px-5 text-base font-semibold rounded-xl cursor-pointer transition-all flex items-center justify-center gap-2 bg-coffee text-white hover:bg-coffee-dark active:scale-[0.98]">
        <span>Order</span>
        <span>☕️</span>
      </button>
      <button id="drinkBtn" class="flex-1 py-3.5 px-5 text-base font-semibold rounded-xl cursor-pointer transition-all flex items-center justify-center gap-2 bg-gray-100 text-gray-700 hover:bg-gray-200 active:scale-[0.98]">
        <span>Drink</span>
        <span>☕️</span>
      </button>
    </div>

    <div id="status" class="text-center mt-4 p-2.5 text-sm font-medium text-gray-500 min-h-[20px] rounded-lg transition-all"></div>

    <button id="learnMoreBtn" class="w-full mt-4 py-2 px-4 text-sm text-coffee hover:text-coffee-dark underline cursor-pointer transition-all">
      Learn more at MCPJam
    </button>
  </div>

  <script>
    const MAX_COFFEES = 10;

    function render(count, message = "") {
      const grid = document.getElementById("coffeeGrid");
      const status = document.getElementById("status");

      grid.innerHTML = "";

      for (let i = 0; i < MAX_COFFEES; i++) {
        const slot = document.createElement("div");
        const isFilled = i < count;

        slot.className = "aspect-square flex items-center justify-center text-3xl rounded-xl transition-all";

        if (isFilled) {
          slot.className += " bg-orange-50";
          slot.textContent = "☕️";
        } else {
          slot.className += " bg-gray-100 border-2 border-dashed border-gray-300";
        }

        grid.appendChild(slot);
      }

      status.textContent = message || "";
      status.className = "text-center mt-4 p-2.5 text-sm font-medium min-h-[20px] rounded-lg transition-all";

      if (message) {
        const isError = message.toLowerCase().includes("sorry") ||
                        message.toLowerCase().includes("no coffee");
        status.className += isError
          ? " bg-red-50 text-red-700"
          : " bg-green-50 text-green-700";
      } else {
        status.className += " text-gray-500";
      }
    }

    function getInitialState() {
      if (window.openai && window.openai.toolOutput) {
        const output = window.openai.toolOutput;
        return {
          count: output.coffeeCount || 0,
          message: output.message || ""
        };
      }
      return { count: 0, message: "Welcome to Coffee Shop!" };
    }

    document.getElementById("orderBtn").addEventListener("click", async () => {
      if (window.openai && window.openai.callTool) {
        const result = await window.openai.callTool("orderCoffee", {});
        if (result && result.structuredContent) {
          render(result.structuredContent.coffeeCount || 0, result.structuredContent.message || "");
        }
      } else {
        console.log("Would call orderCoffee tool");
      }
    });

    document.getElementById("drinkBtn").addEventListener("click", async () => {
      if (window.openai && window.openai.callTool) {
        const result = await window.openai.callTool("drinkCoffee", {});
        if (result && result.structuredContent) {
          render(result.structuredContent.coffeeCount || 0, result.structuredContent.message || "");
        }
      } else {
        console.log("Would call drinkCoffee tool");
      }
    });

    window.addEventListener("openai:set_globals", (event) => {
      if (event.detail && event.detail.globals && event.detail.globals.toolOutput) {
        const output = event.detail.globals.toolOutput;
        render(output.coffeeCount || 0, output.message || "");
      }
    });

    document.getElementById("learnMoreBtn").addEventListener("click", () => {
      if (window.openai && window.openai.openExternal) {
        window.openai.openExternal("https://www.mcpjam.com");
      } else {
        window.open("https://www.mcpjam.com", "_blank");
      }
    });

    const initialState = getInitialState();
    render(initialState.count, initialState.message);
  </script>
</body>
</html>
`;

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
