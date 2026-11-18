import { defineConfig, type Plugin } from "vite";
import { mcpInspector } from "@mcpjam/inspector/vite";
import { startMcpServer } from "./server";

const MCP_PORT = Number(process.env.MCP_PORT ?? 3001);

/** Runs the MCP server inside the Vite dev server, so `npm run dev` starts both. */
function mcpServer(): Plugin {
  return {
    name: "example-mcp-server",
    async configureServer(vite) {
      const http = await startMcpServer(MCP_PORT);
      vite.httpServer?.once("close", () => http.close());
    },
  };
}

export default defineConfig({
  plugins: [
    mcpServer(),
    // Opens MCPJam (or reuses the one already open) with this server added.
    mcpInspector({
      server: { name: "greeter", url: `http://127.0.0.1:${MCP_PORT}/mcp` },
      defaultTab: "tools",
    }),
  ],
});
