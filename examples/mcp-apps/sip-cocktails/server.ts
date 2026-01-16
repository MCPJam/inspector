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

type ServerFactoryOptions = {
  authToken?: string;
};

export function createServer(options: ServerFactoryOptions = {}): McpServer {
  const server = new McpServer({
    name: "Sip Cocktails MCP App Server",
    version: "1.0.0",
    description: "A server for the Sip Cocktails MCP App. This server provides a tool to fetch cocktail recipes and a resource to display them in a widget.",
    websiteUrl: "https://sipcocktails.com",
  });

  const convexUrl = process.env.CONVEX_URL ?? process.env.VITE_CONVEX_URL;
  if (!convexUrl) {
    throw new Error("Missing CONVEX_URL or VITE_CONVEX_URL.");
  }

  const convexClient = new ConvexHttpClient(convexUrl);
  const isAuthenticated = Boolean(options.authToken);

  if (isAuthenticated && options.authToken) {
    convexClient.setAuth(options.authToken);
  }

  const cocktailRecipeWidgetResourceUri =
    "ui://cocktail/cocktail-recipe-widget.html";
  const likedCocktailsWidgetResourceUri =
    "ui://cocktail/liked-cocktails-widget.html";

  const sharedResourceMeta = {
    ui: {
      csp: {
        connectDomains: [convexUrl],
        resourceDomains: [
          convexUrl,
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
      description: "Fetch a cocktail by id with ingredients and images. If the id is unknown, use the 'Get All Cocktails' tool to get a list of all cocktails.",
      inputSchema: z.object({ id: z.string().describe("The id of the cocktail to fetch. ex. 'margarita' or 'bloody_mary'. Ids are lower case and snake case.") }),
      _meta: {
        ui: { resourceUri: cocktailRecipeWidgetResourceUri },
        visibility: ["model", "app"],
        "openai/outputTemplate": "ui://widget/cocktail-recipe-widget-openai.html",
        "openai/toolInvocation/invoking": "Cocktail recipe loading",
        "openai/toolInvocation/invoked": "Cocktail recipe loaded",
      },
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
      const viewer = await getCurrentUser(convexClient, isAuthenticated);
      return {
        content: [
          { type: "text", text: `Loaded cocktail "${cocktail.name}".` },
        ],
        structuredContent: { cocktail, viewer },
      };
    },
  );

  registerAppResource(server,
    cocktailRecipeWidgetResourceUri,
    cocktailRecipeWidgetResourceUri,
    {
      mimeType: RESOURCE_MIME_TYPE,
      _meta: sharedResourceMeta,
    },
    async (): Promise<ReadResourceResult> => {
      const html = await fs.readFile(path.join(DIST_DIR, "cocktail-recipe-widget.html"), "utf-8");
      return {
        contents: [{ uri: cocktailRecipeWidgetResourceUri, mimeType: RESOURCE_MIME_TYPE, text: html, _meta: sharedResourceMeta }],
      };
    },
  );

  server.registerResource(
    "cocktail-recipe-widget",
    "ui://widget/cocktail-recipe-widget-openai.html",
    {},
    async (): Promise<ReadResourceResult> => {
      const html = await fs.readFile(path.join(DIST_DIR, "cocktail-recipe-widget.html"), "utf-8");
      return {
        contents: [{ uri: "ui://widget/cocktail-recipe-widget-openai.html", mimeType: "text/html+skybridge", text: html }],
      };
    },
  );

  registerAppResource(server,
    likedCocktailsWidgetResourceUri,
    likedCocktailsWidgetResourceUri,
    {
      mimeType: RESOURCE_MIME_TYPE,
      _meta: sharedResourceMeta,
    },
    async (): Promise<ReadResourceResult> => {
      const html = await fs.readFile(
        path.join(DIST_DIR, "liked-cocktails-widget.html"),
        "utf-8",
      );
      return {
        contents: [
          {
            uri: likedCocktailsWidgetResourceUri,
            mimeType: RESOURCE_MIME_TYPE,
            text: html,
            _meta: sharedResourceMeta,
          },
        ],
      };
    },
  );

  server.registerTool(
    "get_all_cocktails",
    {
      title: "Get All Cocktails",
      description: "Fetch all cocktail ids with their names.",
      inputSchema: {},
    },
    async (): Promise<CallToolResult> => {
      const cocktails = await convexClient.query(
        api.cocktails.getCocktailIdsAndNames,
        {},
      );
      return {
        content: [
          { type: "text", text: `Loaded ${cocktails.length} cocktails.` },
        ],
        structuredContent: { cocktails },
      };
    },
  );

  if (isAuthenticated) {
    registerAppTool(
      server,
      "get_liked_cocktails",
      {
        title: "Get Liked Cocktails",
        description:
          "Fetch the cocktails in the current user's liked list with details.",
        inputSchema: z.object({}),
        _meta: {
          ui: { resourceUri: likedCocktailsWidgetResourceUri },
          visibility: ["model", "app"],
        },
      },
      async (): Promise<CallToolResult> => {
        const cocktails = await convexClient.query(
          api.cocktails.getLikedCocktailRecipes,
          {},
        );
        return {
          content: [
            {
              type: "text",
              text: `Loaded ${cocktails.length} liked cocktails: ${cocktails.map((cocktail) => cocktail?.id).join(", ")}.`,
            },
          ],
          structuredContent: { cocktails },
        };
      },
    );

    server.registerTool(
      "save_cocktail_recipe_liked_list",
      {
        title: "Get Current User",
        description: "Fetch the current authenticated user from Convex.",
        inputSchema: {
          cocktailId: z
            .string()
            .describe("The id of the cocktail to save to the liked list. ex. 'margarita' or 'bloody_mary'."),
        },
      },
      async ({ cocktailId }: { cocktailId: string }): Promise<CallToolResult> => {
        await convexClient.mutation(api.cocktails.saveCocktailRecipeLikedList, {
          cocktailId,
        });
        return { content: [{ type: "text", text: `Saved cocktail "${cocktailId}" to the liked list.` }] };
      },
    );
  }

  return server;
}

async function getCurrentUser(
  convexClient: ConvexHttpClient,
  isAuthenticated: boolean,
) {
  if (!isAuthenticated) {
    return null;
  }
  try {
    return await convexClient.action(api.users.syncCurrent, {});
  } catch {
    return null;
  }
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
