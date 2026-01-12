import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import type { CallToolResult, ReadResourceResult } from "@modelcontextprotocol/sdk/types.js";
import fs from "node:fs/promises";
import path from "node:path";
import { registerAppTool, registerAppResource, RESOURCE_MIME_TYPE } from "@modelcontextprotocol/ext-apps/server";

const DIST_DIR = path.join(import.meta.dirname, "dist");

/**
 * Creates a new MCP server instance with tools and resources registered.
 */
export function createServer(): McpServer {
  const server = new McpServer({
    name: "Jammy Wammy Reservation Server",
    version: "1.0.0",
  });

  const resourceUri = "ui://reservation/reservation-app.html";

  // Resource: The built HTML file
  registerAppResource(server,
    resourceUri,
    resourceUri,
    { mimeType: RESOURCE_MIME_TYPE },
    async (): Promise<ReadResourceResult> => {
      const html = await fs.readFile(path.join(DIST_DIR, "reservation-app.html"), "utf-8");
      return {
        contents: [{ uri: resourceUri, mimeType: RESOURCE_MIME_TYPE, text: html }],
      };
    },
  );

  // Tool: get-reservation - Shows the reservation UI
  registerAppTool(server,
    "get-reservation",
    {
      title: "Get Reservation",
      description: "Make a reservation at Jammy Wammy restaurant.",
      inputSchema: {},
      _meta: { ui: { resourceUri } },
    },
    async (): Promise<CallToolResult> => {
      return { 
        content: [{ 
          type: "text", 
          text: "Reservation confirmed at Jammy Wammy! 🎉" 
        }] 
      };
    },
  );

  // Tool: get-menu - Returns the menu (no UI)
  server.registerTool(
    "get-menu",
    {
      title: "Get Menu",
      description: "Get the menu for Jammy Wammy restaurant.",
      inputSchema: {},
    },
    async (): Promise<CallToolResult> => {
      const menu = `
🍽️ Jammy Wammy Menu

Appetizers:
- Bruschetta - $8
- Calamari - $12

Main Courses:
- Margherita Pizza - $16
- Spaghetti Carbonara - $18
- Grilled Salmon - $24
- Chicken Parmesan - $20

Desserts:
- Tiramisu - $9
- Panna Cotta - $8

Beverages:
- House Wine (glass) - $10
- Craft Beer - $7
- Fresh Lemonade - $4
      `.trim();

      return { 
        content: [{ 
          type: "text", 
          text: menu 
        }] 
      };
    },
  );

  return server;
}

async function main() {
  const server = createServer();
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
