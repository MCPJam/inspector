// Stdio MCP server used as a target that asks for sign-in mid-run:
//
//   - list_orders — refuses with an `isError` result carrying
//     `_meta["mcp/www_authenticate"]` (the ChatGPT-style challenge; a stdio
//     server has no HTTP status to answer 401 with)
//
// Every execution is appended to the file named by SIGN_IN_TARGET_CALLS_FILE
// (one tool name per line), so a test asserts the call reached the server.
import { appendFileSync } from "node:fs";
import { McpServer } from "@modelcontextprotocol/server";
import { StdioServerTransport } from "@modelcontextprotocol/server/stdio";
import { z } from "zod";

const callsFile = process.env.SIGN_IN_TARGET_CALLS_FILE;

const server = new McpServer(
  { name: "sign-in-target", version: "1.0.0" },
  { capabilities: { tools: {} } }
);

server.registerTool(
  "list_orders",
  {
    description: "List the signed-in user's orders.",
    inputSchema: z.object({}),
  },
  async () => {
    if (callsFile) appendFileSync(callsFile, "list_orders\n");
    return {
      isError: true,
      content: [{ type: "text", text: "Sign in to see your orders." }],
      _meta: {
        "mcp/www_authenticate": [
          'Bearer error="invalid_token", error_description="Sign in required", resource_metadata="https://orders.example/.well-known/oauth-protected-resource", scope="orders:read"',
        ],
      },
    };
  }
);

await server.connect(new StdioServerTransport());
