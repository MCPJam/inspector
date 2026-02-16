import {
  RESOURCE_MIME_TYPE,
  registerAppResource,
  registerAppTool,
} from "@modelcontextprotocol/ext-apps/server";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import type {
  CallToolResult,
  ReadResourceResult,
} from "@modelcontextprotocol/sdk/types.js";
import fs from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import {
  addFlashcards,
  getShuffledFlashcards,
} from "./src/lib/flashcards-db.js";
import { startServer } from "./server-utils.js";

const DIST_DIR = path.join(import.meta.dirname, "dist");
const resourceUri = "ui://flashcards/flashcards-app.html";

const AddFlashcardsItemSchema = z.object({
  question: z.string().min(1),
  answer: z.string().min(1),
  setName: z.string().min(1).optional(),
});

const AddFlashcardsInputSchema = {
  flashcards: z.array(AddFlashcardsItemSchema).min(1),
};

function compactText(value: string): string {
  return value.trim().replace(/\s+/g, " ");
}

export function createServer(): McpServer {
  const server = new McpServer({
    name: "Flashcards Supabase MCP App",
    version: "1.0.0",
  });

  registerAppResource(
    server,
    resourceUri,
    resourceUri,
    { mimeType: RESOURCE_MIME_TYPE },
    async (): Promise<ReadResourceResult> => {
      const html = await fs.readFile(
        path.join(DIST_DIR, "flashcards-app.html"),
        "utf-8",
      );
      return {
        contents: [
          { uri: resourceUri, mimeType: RESOURCE_MIME_TYPE, text: html },
        ],
      };
    },
  );

  registerAppTool(
    server,
    "view_flashcards",
    {
      title: "View flashcards",
      description:
        "Fetch all flashcards, shuffle them randomly, and open an interactive study UI.",
      inputSchema: {},
      _meta: { ui: { resourceUri } },
    },
    async (): Promise<CallToolResult> => {
      const flashcards = await getShuffledFlashcards();

      return {
        content: [
          {
            type: "text",
            text:
              flashcards.length === 0
                ? "No flashcards found yet. Add some flashcards first, then study them here."
                : `Loaded ${flashcards.length} flashcards in randomized order.`,
          },
        ],
        structuredContent: { flashcards },
      };
    },
  );

  server.registerTool(
    "add_flashcards",
    {
      title: "Add flashcards",
      description:
        "Insert one or more question/answer flashcards into Supabase.",
      inputSchema: AddFlashcardsInputSchema,
    },
    async ({ flashcards }): Promise<CallToolResult> => {
      const cleanedCards = flashcards.map((card) => ({
        question: compactText(card.question),
        answer: compactText(card.answer),
        setName: card.setName ? compactText(card.setName) : undefined,
      }));

      const invalidCard = cleanedCards.find(
        (card) => card.question.length === 0 || card.answer.length === 0,
      );
      if (invalidCard) {
        return {
          isError: true,
          content: [
            {
              type: "text",
              text: "Each flashcard must include a non-empty question and answer.",
            },
          ],
        };
      }

      const inserted = await addFlashcards(cleanedCards);

      return {
        content: [
          { type: "text", text: `Added ${inserted.length} flashcards.` },
        ],
        structuredContent: { flashcards: inserted },
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
    await startServer(createServer, {
      port,
      name: "Flashcards Supabase MCP App",
    });
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
