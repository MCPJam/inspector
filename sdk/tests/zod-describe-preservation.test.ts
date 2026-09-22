/**
 * Regression test for the zod 4.2.0 bump.
 *
 * Below zod 4.2.0, the MCP SDK's `~standard.jsonSchema` self-conversion path
 * (used internally by `@modelcontextprotocol/server` when it turns a
 * registered tool's zod `inputSchema` into wire JSON Schema) silently DROPS
 * `.describe()` annotations. This test registers a tool with a described
 * input field, lists it through a real server/client round trip, and
 * asserts the description survives onto the wire `inputSchema`.
 */

import { describe, expect, it } from "vitest";
import { createMcpHandler, McpServer } from "@modelcontextprotocol/server";
import {
  Client,
  StreamableHTTPClientTransport,
} from "@modelcontextprotocol/client";
import { z } from "zod";

const SOME_DESCRIPTION = "SOME_DESCRIPTION";

function buildDescribedToolServer(): McpServer {
  const server = new McpServer(
    { name: "zod-describe-preservation-fixture", version: "1.0.0" },
    { capabilities: { tools: {} } },
  );

  server.registerTool(
    "greet",
    {
      description: "Greets the provided name.",
      inputSchema: {
        name: z.string().describe(SOME_DESCRIPTION),
      },
    },
    async (args) => ({
      content: [{ type: "text" as const, text: `Hello, ${args.name}` }],
    }),
  );

  return server;
}

describe("zod .describe() preservation (4.2.0 regression)", () => {
  it("carries the described input field's description through tools/list", async () => {
    const handler = createMcpHandler(buildDescribedToolServer);
    const client = new Client({
      name: "zod-describe-preservation-test",
      version: "1.0.0",
    });
    const transport = new StreamableHTTPClientTransport(
      new URL("http://fixture.local/mcp"),
      { fetch: (input, init) => handler.fetch(new Request(input as string | URL, init)) },
    );

    try {
      await client.connect(transport);
      const { tools } = await client.listTools();
      const tool = tools.find((t) => t.name === "greet");
      expect(tool).toBeDefined();

      const inputSchema = tool!.inputSchema as {
        properties?: Record<string, { description?: string }>;
      };
      expect(inputSchema.properties?.name?.description).toBe(SOME_DESCRIPTION);
    } finally {
      await client.close();
    }
  });
});
