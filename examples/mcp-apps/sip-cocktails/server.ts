import { registerAppResource, registerAppTool, RESOURCE_MIME_TYPE } from "@modelcontextprotocol/ext-apps/server";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import type { CallToolResult, ReadResourceResult } from "@modelcontextprotocol/sdk/types.js";
import { ConvexHttpClient } from "convex/browser";
import fs from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import { startServer } from "./server-utils.js";
import { api } from "./convex/_generated/api.js";

const DIST_DIR = path.join(import.meta.dirname, "dist");

/**
 * Creates a new MCP server instance with tools and resources registered.
 */
export function createServer(): McpServer {
  const server = new McpServer({
    name: "Sip Cocktails MCP App Server",
    version: "1.0.0",
  });
  const convexUrl = process.env.CONVEX_URL ?? process.env.VITE_CONVEX_URL;
  if (!convexUrl) {
    throw new Error("Missing CONVEX_URL or VITE_CONVEX_URL.");
  }
  const convexClient = new ConvexHttpClient(convexUrl);
  const resourceUri = "ui://cocktail/cocktail-recipe-widget.html";

  const sharedResourceMeta = {
    ui: {
      csp: {
        connectDomains: ["https://sleek-hound-600.convex.cloud"],
        resourceDomains: [
          "https://sleek-hound-600.convex.cloud",
          "https://fonts.googleapis.com",
          "https://fonts.gstatic.com",
        ],
      },
    },
  };

  registerAppTool(server,
    "get-cocktail",
    {
      title: "Get Cocktail",
      description: "Fetch a cocktail by id with ingredients and images.",
      inputSchema: z.object({ id: z.string() }),
      _meta: { ui: { resourceUri, visibility: ["app"] } },
    },
    async ({ id }: { id: string }): Promise<CallToolResult> => {
      const cocktail = await convexClient.query(api.cocktails.getCocktailById, {
        id,
      });
      if (!cocktail) {
        return {
          content: [{ type: "text", text: `Cocktail "${id}" not found.` }],
          isError: true,
        };
      }
      return {
        content: [
          { type: "text", text: `Loaded cocktail "${cocktail.name}".` },
        ],
        structuredContent: { cocktail },
      };
    },
  );

  registerAppResource(server,
    resourceUri,
    resourceUri,
    {
      mimeType: RESOURCE_MIME_TYPE,
      _meta: sharedResourceMeta,
    },
    async (): Promise<ReadResourceResult> => {
      const html = await fs.readFile(path.join(DIST_DIR, "cocktail-recipe-widget.html"), "utf-8");
      return {
        contents: [{ uri: resourceUri, mimeType: RESOURCE_MIME_TYPE, text: html, _meta: sharedResourceMeta }],
      };
    },
  );

  return server;
}

async function main() {
  if (process.argv.includes("--stdio")) {
    await createServer().connect(new StdioServerTransport());
  } else {
    const port = parseInt(process.env.PORT ?? "3001", 10);
    await startServer(createServer, { port, name: "Sip Cocktails MCP App Server" });
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
