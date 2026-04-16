import { McpJamMcpServer } from "./server.js";

export { McpJamMcpServer };

const LANDING_PAGE = `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <title>MCPJam MCP</title>
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <style>
      body { font-family: system-ui, sans-serif; max-width: 40rem; margin: 4rem auto; padding: 0 1rem; line-height: 1.5; }
      code { background: #f4f4f5; padding: 0.1rem 0.35rem; border-radius: 0.25rem; }
    </style>
  </head>
  <body>
    <h1>MCPJam MCP</h1>
    <p>This is the MCPJam remote MCP server. Connect an MCP client to <code>/mcp</code>.</p>
    <p>Source: <a href="https://github.com/MCPJam/inspector">github.com/MCPJam/inspector</a></p>
  </body>
</html>
`;

export default {
  async fetch(
    request: Request,
    env: Env,
    ctx: ExecutionContext,
  ): Promise<Response> {
    const url = new URL(request.url);

    if (url.pathname === "/mcp" || url.pathname.startsWith("/mcp/")) {
      return McpJamMcpServer.serve("/mcp").fetch(request, env, ctx);
    }

    if (url.pathname === "/" && request.method === "GET") {
      return new Response(LANDING_PAGE, {
        headers: { "content-type": "text/html; charset=utf-8" },
      });
    }

    return new Response("Not found", { status: 404 });
  },
} satisfies ExportedHandler<Env>;
