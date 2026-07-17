import { McpServer, ResourceTemplate } from "@modelcontextprotocol/server";
import { z } from "zod";
import type { CaptureSession } from "./capture.js";
import type { AccessToken } from "./store.js";

const TEST_IMAGE_BASE64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFBQIAX8jx0gAAAABJRU5ErkJggg==";

export const UI_TOOL_NAME = "reference_ui_dashboard";
export const UI_RESOURCE_URI = "ui://oauth-reference/dashboard";
const UI_RESOURCE_MIME_TYPE = "text/html;profile=mcp-app";

const DASHBOARD_HTML = `<!doctype html>
<html lang="en">
<head><meta charset="utf-8" /><title>OAuth Reference Dashboard</title></head>
<body><main id="app"><h1>OAuth reference server</h1><p>You are seeing this through an authenticated MCP Apps render.</p></main></body>
</html>`;

/** Build one full-capability MCP server bound to the authenticated token that
 * opened the session. Everything here sits behind the bearer gate in http.ts. */
export function createReferenceMcpServer(auth: AccessToken, capture: () => CaptureSession): McpServer {
  const server = new McpServer(
    { name: "mcpjam-oauth-reference-server", version: "0.1.0" },
    {
      capabilities: {
        tools: {},
        resources: { subscribe: true },
        prompts: {},
        logging: {},
        completions: {},
      },
    },
  );

  // --- tools ---------------------------------------------------------------

  server.registerTool(
    "whoami",
    {
      description:
        "Echo the authenticated OAuth context (client_id, scopes, grant, expiry). Proves end-to-end auth.",
      inputSchema: z.object({}),
    },
    async () => ({
      content: [
        {
          type: "text",
          text: JSON.stringify(
            {
              clientId: auth.clientId,
              scopes: auth.scopes,
              grant: auth.grant,
              resource: auth.resource ?? null,
              expiresAt: new Date(auth.expiresAt).toISOString(),
            },
            null,
            2,
          ),
        },
      ],
    }),
  );

  server.registerTool(
    "test_simple_text",
    {
      description: "Returns a simple text response.",
      inputSchema: z.object({}),
    },
    async () => ({
      content: [{ type: "text", text: "Simple text response from the OAuth reference server." }],
    }),
  );

  server.registerTool(
    "test_image_content",
    {
      description: "Returns PNG image content.",
      inputSchema: z.object({}),
    },
    async () => ({
      content: [{ type: "image", data: TEST_IMAGE_BASE64, mimeType: "image/png" }],
    }),
  );

  server.registerTool(
    "test_tool_with_logging",
    {
      description: "Emits logging notifications during execution.",
      inputSchema: z.object({}),
    },
    async (_args, ctx) => {
      for (const step of ["started", "processing", "completed"]) {
        await ctx.mcpReq.log("info", `Tool execution ${step}`);
      }
      return { content: [{ type: "text", text: "Tool with logging executed successfully" }] };
    },
  );

  server.registerTool(
    "test_tool_with_progress",
    {
      description: "Emits progress notifications during execution.",
      inputSchema: z.object({}),
    },
    async (_args, ctx) => {
      const progressToken = ctx.mcpReq._meta?.progressToken ?? 0;
      for (const progress of [0, 50, 100]) {
        await ctx.mcpReq.notify({
          method: "notifications/progress",
          params: { progressToken, progress, total: 100, message: `Step ${progress}/100` },
        });
      }
      return { content: [{ type: "text", text: "Tool with progress executed successfully" }] };
    },
  );

  server.registerTool(
    "test_error_handling",
    {
      description: "Intentionally returns a tool error.",
      inputSchema: z.object({}),
    },
    async () => {
      throw new Error("This tool intentionally returns an error for testing");
    },
  );

  server.registerTool(
    "test_elicitation",
    {
      description:
        "Requests user input via elicitation/create and reports what the client did (answered, declined, or unsupported).",
      inputSchema: z.object({}),
    },
    async (_args, ctx) => {
      try {
        const result = await ctx.mcpReq.elicitInput({
          message: "The OAuth reference server wants one detail to complete the capability check.",
          requestedSchema: {
            type: "object",
            properties: {
              favorite_color: {
                type: "string",
                title: "Favorite color",
                description: "Any value works — this only probes elicitation support.",
              },
            },
            required: ["favorite_color"],
          },
        });
        capture().record({
          kind: "mcp_request",
          method: "POST",
          path: "/mcp",
          status: 200,
          detail: {
            rpcMethod: "elicitation/create",
            elicitationResult: result.action === "accept" ? "answered" : result.action,
          },
        });
        return {
          content: [
            {
              type: "text",
              text: `Elicitation result: action=${result.action}${
                result.action === "accept" ? `, content=${JSON.stringify(result.content)}` : ""
              }`,
            },
          ],
        };
      } catch (error) {
        capture().record({
          kind: "mcp_request",
          method: "POST",
          path: "/mcp",
          status: 200,
          detail: { rpcMethod: "elicitation/create", elicitationResult: "rejected-or-unsupported" },
        });
        return {
          content: [
            {
              type: "text",
              text: `Elicitation not completed: ${error instanceof Error ? error.message : "unknown error"}`,
            },
          ],
        };
      }
    },
  );

  server.registerTool(
    UI_TOOL_NAME,
    {
      description: "Returns dashboard data and advertises an MCP Apps HTML resource.",
      inputSchema: z.object({}),
      _meta: {
        ui: { resourceUri: UI_RESOURCE_URI, visibility: ["model", "app"] },
      },
    },
    async () => ({
      content: [{ type: "text", text: "Dashboard ready." }],
      structuredContent: { status: "ready", authenticatedClient: auth.clientId },
    }),
  );

  // --- resources -----------------------------------------------------------

  server.registerResource(
    "static-text",
    "reference://static-text",
    {
      title: "Static Text Resource",
      description: "A static text resource behind OAuth.",
      mimeType: "text/plain",
    },
    async () => ({
      contents: [
        {
          uri: "reference://static-text",
          mimeType: "text/plain",
          text: "Static text resource content (authenticated).",
        },
      ],
    }),
  );

  server.registerResource(
    "static-binary",
    "reference://static-binary",
    {
      title: "Static Binary Resource",
      description: "A static PNG resource behind OAuth.",
      mimeType: "image/png",
    },
    async () => ({
      contents: [
        { uri: "reference://static-binary", mimeType: "image/png", blob: TEST_IMAGE_BASE64 },
      ],
    }),
  );

  server.registerResource(
    "template",
    new ResourceTemplate("reference://template/{id}/data", { list: undefined }),
    {
      title: "Template Resource",
      description: "A resource template with path parameter substitution.",
      mimeType: "application/json",
    },
    async (uri, variables) => ({
      contents: [
        {
          uri: uri.toString(),
          mimeType: "application/json",
          text: JSON.stringify({ id: variables.id, data: `Data for ID: ${variables.id}` }),
        },
      ],
    }),
  );

  server.registerResource(
    "watched-resource",
    "reference://watched-resource",
    {
      title: "Watched Resource",
      description: "A subscribable resource.",
      mimeType: "text/plain",
    },
    async () => ({
      contents: [
        {
          uri: "reference://watched-resource",
          mimeType: "text/plain",
          text: "Watched resource content",
        },
      ],
    }),
  );

  server.registerResource(
    "ui-dashboard",
    UI_RESOURCE_URI,
    {
      title: "UI Dashboard",
      description: "An MCP Apps HTML resource behind OAuth.",
      mimeType: UI_RESOURCE_MIME_TYPE,
    },
    async () => ({
      contents: [
        {
          uri: UI_RESOURCE_URI,
          mimeType: UI_RESOURCE_MIME_TYPE,
          text: DASHBOARD_HTML,
          _meta: {
            ui: {
              csp: { connectDomains: [], resourceDomains: [] },
              permissions: {},
              prefersBorder: true,
            },
          },
        },
      ],
    }),
  );

  // --- prompts ---------------------------------------------------------------

  server.registerPrompt(
    "test_simple_prompt",
    {
      title: "Simple Prompt",
      description: "A simple prompt without arguments.",
    },
    async () => ({
      messages: [
        {
          role: "user",
          content: { type: "text", text: "This is a simple prompt from the OAuth reference server." },
        },
      ],
    }),
  );

  server.registerPrompt(
    "test_prompt_with_arguments",
    {
      title: "Prompt With Arguments",
      description: "A prompt that substitutes provided arguments.",
      argsSchema: z.object({
        topic: z.string().describe("Topic to ask about"),
      }),
    },
    async (args) => ({
      messages: [
        {
          role: "user",
          content: { type: "text", text: `Tell me about: ${args.topic}` },
        },
      ],
    }),
  );

  // --- logging / completion / subscriptions ---------------------------------

  const resourceSubscriptions = new Set<string>();

  server.server.setRequestHandler("resources/subscribe", async (request: any) => {
    resourceSubscriptions.add(request.params.uri);
    return {};
  });
  server.server.setRequestHandler("resources/unsubscribe", async (request: any) => {
    resourceSubscriptions.delete(request.params.uri);
    return {};
  });
  server.server.setRequestHandler("logging/setLevel", async () => ({}));
  server.server.setRequestHandler("completion/complete", async () => ({
    completion: { values: ["alpha", "beta", "gamma"], total: 3, hasMore: false },
  }));

  return server;
}
