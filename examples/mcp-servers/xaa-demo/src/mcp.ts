import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

// A minimal but genuine MCP server: one tool the debugger (or any MCP client)
// can call once the door opens.
export function buildMcpServer(): McpServer {
  const server = new McpServer({ name: "xaa-demo", version: "1.0.0" });
  server.tool(
    "get_forecast",
    "Return a canned weather forecast for a city.",
    { city: z.string().describe("City name") },
    async ({ city }) => ({
      content: [{ type: "text", text: `Forecast for ${city}: sunny, 24°C.` }],
    }),
  );
  return server;
}
