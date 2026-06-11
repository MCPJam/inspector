// LOCAL-DEV ONLY — minimal streamable-HTTP MCP server with one echo tool.
//
// Logging exception (AGENTS.md): standalone dev scripts under scripts/ write
// to the terminal with console.* like their siblings (dev-worktree.mjs,
// verify-local-sdk-link.mjs) — the server logger (Sentry, --verbose gating)
// is for server/ runtime code and doesn't apply to a throwaway local tool.
import { createServer } from "node:http";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { z } from "zod";

const PORT = 9400;

function buildServer() {
  const server = new McpServer({ name: "local-echo", version: "1.0.0" });
  server.tool(
    "echo",
    "Echo back the provided text",
    { text: z.string().describe("Text to echo") },
    async ({ text }) => ({ content: [{ type: "text", text: `echo: ${text}` }] })
  );
  return server;
}

const httpServer = createServer(async (req, res) => {
  if (!req.url?.startsWith("/mcp")) {
    res.writeHead(404).end();
    return;
  }
  try {
    // Stateless: new server+transport per request.
    const server = buildServer();
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
    });
    res.on("close", () => {
      transport.close();
      server.close();
    });
    await server.connect(transport);
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const body = chunks.length
      ? JSON.parse(Buffer.concat(chunks).toString())
      : undefined;
    await transport.handleRequest(req, res, body);
  } catch (error) {
    console.error("mcp request failed", error);
    if (!res.headersSent) res.writeHead(500).end();
  }
});

httpServer.listen(PORT, "127.0.0.1", () =>
  console.log(`echo MCP server on http://127.0.0.1:${PORT}/mcp`)
);
