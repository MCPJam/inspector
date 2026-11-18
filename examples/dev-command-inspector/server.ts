import { createServer, type Server } from "node:http";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { z } from "zod";

/** The example's MCP server: one tool, so the first tool call is one click away. */
function buildServer(): McpServer {
  const server = new McpServer({ name: "greeter", version: "1.0.0" });
  server.registerTool(
    "greet",
    {
      description: "Say hello to someone.",
      inputSchema: { name: z.string().describe("Who to greet") },
    },
    async ({ name }) => ({
      content: [{ type: "text", text: `Hello, ${name}!` }],
    }),
  );
  return server;
}

/** Serves the MCP server over stateless Streamable HTTP at `/mcp`. */
export function startMcpServer(port: number): Promise<Server> {
  const http = createServer(async (req, res) => {
    if (!req.url?.startsWith("/mcp")) {
      res.writeHead(404).end();
      return;
    }
    const server = buildServer();
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
    });
    res.on("close", () => {
      void transport.close();
      void server.close();
    });
    await server.connect(transport);
    await transport.handleRequest(req, res);
  });
  return new Promise((resolve) => http.listen(port, "127.0.0.1", () => resolve(http)));
}
