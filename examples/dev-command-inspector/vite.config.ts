import { defineConfig, type Plugin } from "vite";
import { mcpInspector } from "@mcpjam/inspector/vite";
import { handleMcpRequest } from "./server";

const PORT = Number(process.env.PORT ?? 3001);

/**
 * Serves the MCP server at /mcp on Vite's own port, so `npm run dev` starts
 * both with nothing else to bind. Editing server.ts restarts Vite, which
 * reloads this plugin and the handler with it.
 */
function mcpServer(): Plugin {
  return {
    name: "example-mcp-server",
    configureServer(vite) {
      vite.middlewares.use("/mcp", (req, res) => {
        void handleMcpRequest(req, res);
      });
    },
  };
}

export default defineConfig({
  // A fixed address, because the plugin is told the server's URL up front.
  server: { host: "127.0.0.1", port: PORT, strictPort: true },
  plugins: [
    mcpServer(),
    // Opens MCPJam (or reuses the one already open) with this server added.
    // A Vite restart keeps the same MCPJam and the same server entry.
    mcpInspector({
      server: { name: "greeter", url: `http://127.0.0.1:${PORT}/mcp` },
      defaultTab: "tools",
    }),
  ],
});
