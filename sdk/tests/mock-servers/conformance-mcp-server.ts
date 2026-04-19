import http from "node:http";
import { randomUUID } from "node:crypto";
import type { AddressInfo } from "node:net";
import {
  McpServer,
  ResourceTemplate,
} from "@modelcontextprotocol/server";
import {
  NodeStreamableHTTPServerTransport,
  type EventId,
  type EventStore,
  type StreamId,
} from "@modelcontextprotocol/node";
import { z } from "zod";

const TEST_IMAGE_BASE64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFBQIAX8jx0gAAAABJRU5ErkJggg==";
export const CONFORMANCE_UI_TOOL_NAME = "test_ui_dashboard";
export const CONFORMANCE_UI_RESOURCE_URI = "ui://test/dashboard";
const CONFORMANCE_UI_RESOURCE_MIME_TYPE = "text/html;profile=mcp-app";

type ConformanceServerOptions = {
  omitTools?: string[];
  omitPrompts?: string[];
  omitResources?: string[];
  omitResourceTemplates?: boolean;
  omitCompletion?: boolean;
  omitLogging?: boolean;
  omitToolDescriptions?: string[];
  omitPromptDescriptions?: string[];
  statelessTransport?: boolean;
};

function shouldOmitDescription(
  omittedNames: string[] | undefined,
  name: string,
): boolean {
  return omittedNames?.includes(name) ?? false;
}

function parseHostHeader(value: string): string {
  try {
    return new URL(`http://${value}`).hostname.toLowerCase();
  } catch {
    return value.toLowerCase();
  }
}

function isLocalHeaderValue(value: string | undefined, type: "host" | "origin"): boolean {
  if (!value) {
    return true;
  }

  try {
    const hostname =
      type === "origin"
        ? new URL(value).hostname.toLowerCase()
        : parseHostHeader(value);
    return (
      hostname === "localhost" ||
      hostname === "127.0.0.1" ||
      hostname === "::1" ||
      hostname === "[::1]"
    );
  } catch {
    return false;
  }
}

function shouldRejectForRebinding(req: http.IncomingMessage): boolean {
  const hostHeader = Array.isArray(req.headers.host)
    ? req.headers.host[0]
    : req.headers.host;
  const originHeader = Array.isArray(req.headers.origin)
    ? req.headers.origin[0]
    : req.headers.origin;

  return (
    !isLocalHeaderValue(hostHeader, "host") ||
    !isLocalHeaderValue(originHeader, "origin")
  );
}

async function readJsonBody(req: http.IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }

  if (chunks.length === 0) {
    return undefined;
  }

  const bodyText = Buffer.concat(chunks).toString("utf8");
  return JSON.parse(bodyText);
}

function isInitializeRequest(body: unknown): boolean {
  return (
    !!body &&
    typeof body === "object" &&
    (body as { method?: unknown }).method === "initialize"
  );
}

function createEventStore() {
  const events = new Map<
    string,
    { eventId: string; message: unknown; streamId: string }
  >();

  const eventStore: EventStore = {
    async storeEvent(streamId: StreamId, message: unknown): Promise<EventId> {
      const eventId = `${streamId}::${Date.now()}_${randomUUID()}`;
      events.set(eventId, { eventId, message, streamId });
      return eventId as EventId;
    },
    async replayEventsAfter(
      lastEventId: EventId,
      { send }: { send: (eventId: EventId, message: unknown) => Promise<void> },
    ): Promise<StreamId> {
      const streamId = String(lastEventId).split("::")[0];
      const replayableEvents = [...events.values()]
        .filter((event) => event.streamId === streamId && event.eventId > lastEventId)
        .sort((left, right) => left.eventId.localeCompare(right.eventId));

      for (const event of replayableEvents) {
        await send(event.eventId as EventId, event.message);
      }

      return streamId as StreamId;
    },
  };

  return eventStore;
}

function createMcpServer(
  options: ConformanceServerOptions,
  transportLookup: (
    sessionId: string,
  ) => NodeStreamableHTTPServerTransport | undefined,
) {
  const omittedTools = new Set(options.omitTools ?? []);
  const omittedPrompts = new Set(options.omitPrompts ?? []);
  const omittedResources = new Set(options.omitResources ?? []);
  const watchedResourceContent = "Watched resource content";
  const resourceSubscriptions = new Set<string>();

  const server = new McpServer(
    {
      name: "mcpjam-conformance-test-server",
      version: "1.0.0",
    },
    {
      capabilities: {
        tools: {},
        resources: {
          subscribe: true,
        },
        prompts: {},
        ...(options.omitLogging ? {} : { logging: {} }),
        completions: options.omitCompletion ? undefined : {},
      },
    },
  );

  const sendLog = async (level: "debug" | "info" | "warning" | "error", data: string) => {
    await server.server.notification({
      method: "notifications/message",
      params: {
        level,
        data,
        logger: "mcpjam-conformance-test-server",
      },
    }).catch(() => undefined);
  };

  if (!omittedTools.has("test_simple_text")) {
    server.registerTool(
      "test_simple_text",
      {
        description: shouldOmitDescription(
          options.omitToolDescriptions,
          "test_simple_text",
        )
          ? undefined
          : "Returns a simple text response for conformance testing.",
        inputSchema: z.object({}),
      },
      async () => ({
        content: [
          {
            type: "text",
            text: "This is a simple text response for testing.",
          },
        ],
      }),
    );
  }

  if (!omittedTools.has("test_image_content")) {
    server.registerTool(
      "test_image_content",
      {
        description: shouldOmitDescription(
          options.omitToolDescriptions,
          "test_image_content",
        )
          ? undefined
          : "Returns image content for conformance testing.",
        inputSchema: z.object({}),
      },
      async () => ({
        content: [
          {
            type: "image",
            data: TEST_IMAGE_BASE64,
            mimeType: "image/png",
          },
        ],
      }),
    );
  }

  if (!omittedTools.has("test_embedded_resource")) {
    server.registerTool(
      "test_embedded_resource",
      {
        description: shouldOmitDescription(
          options.omitToolDescriptions,
          "test_embedded_resource",
        )
          ? undefined
          : "Returns embedded resource content for conformance testing.",
        inputSchema: z.object({}),
      },
      async () => ({
        content: [
          {
            type: "resource",
            resource: {
              uri: "test://embedded-resource",
              mimeType: "text/plain",
              text: "This is an embedded resource content.",
            },
          },
        ],
      }),
    );
  }

  if (!omittedTools.has("test_multiple_content_types")) {
    server.registerTool(
      "test_multiple_content_types",
      {
        description: shouldOmitDescription(
          options.omitToolDescriptions,
          "test_multiple_content_types",
        )
          ? undefined
          : "Returns text, image, and resource content together.",
        inputSchema: z.object({}),
      },
      async () => ({
        content: [
          {
            type: "text",
            text: "Multiple content types test:",
          },
          {
            type: "image",
            data: TEST_IMAGE_BASE64,
            mimeType: "image/png",
          },
          {
            type: "resource",
            resource: {
              uri: "test://mixed-content-resource",
              mimeType: "application/json",
              text: JSON.stringify({ test: "data", value: 123 }),
            },
          },
        ],
      }),
    );
  }

  if (!omittedTools.has("test_tool_with_logging")) {
    server.registerTool(
      "test_tool_with_logging",
      {
        description: shouldOmitDescription(
          options.omitToolDescriptions,
          "test_tool_with_logging",
        )
          ? undefined
          : "Emits logging notifications during execution.",
        inputSchema: z.object({}),
      },
      async (_args, { sendNotification }) => {
        await sendNotification({
          method: "notifications/message",
          params: {
            level: "info",
            data: "Tool execution started",
          },
        });
        await new Promise((resolve) => setTimeout(resolve, 50));
        await sendNotification({
          method: "notifications/message",
          params: {
            level: "info",
            data: "Tool processing data",
          },
        });
        await new Promise((resolve) => setTimeout(resolve, 50));
        await sendNotification({
          method: "notifications/message",
          params: {
            level: "info",
            data: "Tool execution completed",
          },
        });

        return {
          content: [
            {
              type: "text",
              text: "Tool with logging executed successfully",
            },
          ],
        };
      },
    );
  }

  if (!omittedTools.has("test_tool_with_progress")) {
    server.registerTool(
      "test_tool_with_progress",
      {
        description: shouldOmitDescription(
          options.omitToolDescriptions,
          "test_tool_with_progress",
        )
          ? undefined
          : "Emits progress notifications during execution.",
        inputSchema: z.object({}),
      },
      async (_args, { sendNotification, _meta }) => {
        const progressToken = _meta?.progressToken ?? 0;

        for (const progress of [0, 50, 100]) {
          await sendNotification({
            method: "notifications/progress",
            params: {
              progressToken,
              progress,
              total: 100,
              message: `Completed step ${progress} of 100`,
            },
          });

          if (progress < 100) {
            await new Promise((resolve) => setTimeout(resolve, 50));
          }
        }

        return {
          content: [
            {
              type: "text",
              text: "Tool with progress executed successfully",
            },
          ],
        };
      },
    );
  }

  if (!omittedTools.has("test_error_handling")) {
    server.registerTool(
      "test_error_handling",
      {
        description: shouldOmitDescription(
          options.omitToolDescriptions,
          "test_error_handling",
        )
          ? undefined
          : "Returns a tool error for conformance testing.",
        inputSchema: z.object({}),
      },
      async () => {
        throw new Error("This tool intentionally returns an error for testing");
      },
    );
  }

  if (!omittedTools.has("test_reconnection")) {
    server.registerTool(
      "test_reconnection",
      {
        description: shouldOmitDescription(
          options.omitToolDescriptions,
          "test_reconnection",
        )
          ? undefined
          : "Closes the SSE stream and relies on reconnection to resume.",
        inputSchema: z.object({}),
      },
      async (_args, { sessionId, requestId }) => {
        const transport = sessionId ? transportLookup(sessionId) : undefined;
        if (transport && requestId) {
          (transport as { closeSSEStream?: (id: unknown) => void }).closeSSEStream?.(
            requestId,
          );
        }

        await new Promise((resolve) => setTimeout(resolve, 100));

        return {
          content: [
            {
              type: "text",
              text: "Reconnection test completed successfully.",
            },
          ],
        };
      },
    );
  }

  if (!omittedResources.has("test://static-text")) {
    server.registerResource(
      "static-text",
      "test://static-text",
      {
        title: "Static Text Resource",
        description: "A static text resource for conformance testing.",
        mimeType: "text/plain",
      },
      async () => ({
        contents: [
          {
            uri: "test://static-text",
            mimeType: "text/plain",
            text: "This is the content of the static text resource.",
          },
        ],
      }),
    );
  }

  if (!omittedTools.has(CONFORMANCE_UI_TOOL_NAME)) {
    server.registerTool(
      CONFORMANCE_UI_TOOL_NAME,
      {
        description: shouldOmitDescription(
          options.omitToolDescriptions,
          CONFORMANCE_UI_TOOL_NAME,
        )
          ? undefined
          : "Returns dashboard data and advertises an MCP Apps HTML resource.",
        inputSchema: z.object({}),
        _meta: {
          ui: {
            resourceUri: CONFORMANCE_UI_RESOURCE_URI,
            visibility: ["model", "app"],
          },
        },
      },
      async () => ({
        content: [
          {
            type: "text",
            text: "Dashboard ready.",
          },
        ],
        structuredContent: {
          status: "ready",
          cards: [
            { id: "summary", label: "Summary", value: 42 },
          ],
        },
      }),
    );
  }

  if (!omittedResources.has("test://static-binary")) {
    server.registerResource(
      "static-binary",
      "test://static-binary",
      {
        title: "Static Binary Resource",
        description: "A static binary resource for conformance testing.",
        mimeType: "image/png",
      },
      async () => ({
        contents: [
          {
            uri: "test://static-binary",
            mimeType: "image/png",
            blob: TEST_IMAGE_BASE64,
          },
        ],
      }),
    );
  }

  if (!options.omitResourceTemplates) {
    server.registerResource(
      "template",
      new ResourceTemplate("test://template/{id}/data", {
        list: undefined,
      }),
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
            text: JSON.stringify({
              id: variables.id,
              templateTest: true,
              data: `Data for ID: ${variables.id}`,
            }),
          },
        ],
      }),
    );
  }

  if (!omittedResources.has("test://watched-resource")) {
    server.registerResource(
      "watched-resource",
      "test://watched-resource",
      {
        title: "Watched Resource",
        description: "A subscribable resource for conformance testing.",
        mimeType: "text/plain",
      },
      async () => ({
        contents: [
          {
            uri: "test://watched-resource",
            mimeType: "text/plain",
            text: watchedResourceContent,
          },
        ],
      }),
    );
  }

  if (!omittedResources.has(CONFORMANCE_UI_RESOURCE_URI)) {
    server.registerResource(
      "ui-dashboard",
      CONFORMANCE_UI_RESOURCE_URI,
      {
        title: "UI Dashboard",
        description: "An MCP Apps HTML resource for conformance testing.",
        mimeType: CONFORMANCE_UI_RESOURCE_MIME_TYPE,
      },
      async () => ({
        contents: [
          {
            uri: CONFORMANCE_UI_RESOURCE_URI,
            mimeType: CONFORMANCE_UI_RESOURCE_MIME_TYPE,
            text: [
              "<!DOCTYPE html>",
              '<html lang="en">',
              "<head>",
              '  <meta charset="utf-8" />',
              "  <title>Conformance Dashboard</title>",
              "</head>",
              "<body>",
              '  <main id="app">MCP Apps conformance dashboard</main>',
              "</body>",
              "</html>",
            ].join("\n"),
            _meta: {
              ui: {
                csp: {
                  connectDomains: ["https://api.example.com"],
                  resourceDomains: ["https://cdn.example.com"],
                  frameDomains: ["https://frames.example.com"],
                  baseUriDomains: ["https://assets.example.com"],
                },
                permissions: {
                  geolocation: {},
                  clipboardWrite: {},
                },
                domain: "conformance-dashboard.oaiusercontent.test",
                prefersBorder: true,
              },
            },
          },
        ],
      }),
    );
  }

  if (!omittedPrompts.has("test_simple_prompt")) {
    server.registerPrompt(
      "test_simple_prompt",
      {
        title: "Simple Prompt",
        description: shouldOmitDescription(
          options.omitPromptDescriptions,
          "test_simple_prompt",
        )
          ? undefined
          : "A simple prompt without arguments.",
      },
      async () => ({
        messages: [
          {
            role: "user",
            content: {
              type: "text",
              text: "This is a simple prompt for testing.",
            },
          },
        ],
      }),
    );
  }

  if (!omittedPrompts.has("test_prompt_with_arguments")) {
    server.registerPrompt(
      "test_prompt_with_arguments",
      {
        title: "Prompt With Arguments",
        description: shouldOmitDescription(
          options.omitPromptDescriptions,
          "test_prompt_with_arguments",
        )
          ? undefined
          : "A prompt that substitutes provided arguments.",
        argsSchema: z.object({
          arg1: z.string().describe("First test argument"),
          arg2: z.string().describe("Second test argument"),
        }),
      },
      async (args) => ({
        messages: [
          {
            role: "user",
            content: {
              type: "text",
              text: `Prompt with arguments: arg1='${args.arg1}', arg2='${args.arg2}'`,
            },
          },
        ],
      }),
    );
  }

  if (!omittedPrompts.has("test_prompt_with_embedded_resource")) {
    server.registerPrompt(
      "test_prompt_with_embedded_resource",
      {
        title: "Prompt With Embedded Resource",
        description: shouldOmitDescription(
          options.omitPromptDescriptions,
          "test_prompt_with_embedded_resource",
        )
          ? undefined
          : "A prompt that includes resource content.",
        argsSchema: z.object({
          resourceUri: z.string().describe("Resource URI"),
        }),
      },
      async (args) => ({
        messages: [
          {
            role: "user",
            content: {
              type: "resource",
              resource: {
                uri: args.resourceUri,
                mimeType: "text/plain",
                text: "Embedded resource content for testing.",
              },
            },
          },
          {
            role: "user",
            content: {
              type: "text",
              text: "Please process the embedded resource above.",
            },
          },
        ],
      }),
    );
  }

  if (!omittedPrompts.has("test_prompt_with_image")) {
    server.registerPrompt(
      "test_prompt_with_image",
      {
        title: "Prompt With Image",
        description: shouldOmitDescription(
          options.omitPromptDescriptions,
          "test_prompt_with_image",
        )
          ? undefined
          : "A prompt that includes image content.",
      },
      async () => ({
        messages: [
          {
            role: "user",
            content: {
              type: "image",
              data: TEST_IMAGE_BASE64,
              mimeType: "image/png",
            },
          },
          {
            role: "user",
            content: {
              type: "text",
              text: "Please analyze the image above.",
            },
          },
        ],
      }),
    );
  }

  server.server.setRequestHandler(
    "resources/subscribe",
    async (request: any) => {
      resourceSubscriptions.add(request.params.uri);
      await sendLog("info", `Subscribed to resource: ${request.params.uri}`);
      return {};
    },
  );

  server.server.setRequestHandler(
    "resources/unsubscribe",
    async (request: any) => {
      resourceSubscriptions.delete(request.params.uri);
      await sendLog("info", `Unsubscribed from resource: ${request.params.uri}`);
      return {};
    },
  );

  if (!options.omitLogging) {
    server.server.setRequestHandler(
      "logging/setLevel",
      async (request: any) => {
        await sendLog("info", `Log level set to: ${request.params.level}`);
        return {};
      },
    );
  }

  if (!options.omitCompletion) {
    server.server.setRequestHandler(
      "completion/complete",
      async () => ({
        completion: {
          values: ["paris", "park", "party"],
          total: 3,
          hasMore: false,
        },
      }),
    );
  }

  return server;
}

export async function startConformanceMockServer(
  options: ConformanceServerOptions = {},
): Promise<{ server: http.Server; url: string; stop: () => Promise<void> }> {
  const transports = new Map<string, NodeStreamableHTTPServerTransport>();
  const servers = new Map<string, McpServer>();

  const httpServer = http.createServer(async (req, res) => {
    if (shouldRejectForRebinding(req)) {
      res.writeHead(403, { "Content-Type": "application/json" });
      res.end(
        JSON.stringify({
          jsonrpc: "2.0",
          error: {
            code: -32001,
            message: "Rejected request with invalid Host or Origin header",
          },
          id: null,
        }),
      );
      return;
    }

    if (req.url !== "/mcp") {
      res.writeHead(404);
      res.end("Not found");
      return;
    }

    try {
      if (req.method === "POST") {
        const body = await readJsonBody(req);

        if (options.statelessTransport) {
          const server = createMcpServer(options, () => undefined);
          const transport = new NodeStreamableHTTPServerTransport({
            sessionIdGenerator: undefined,
          });

          res.on("close", () => {
            void transport.close().catch(() => undefined);
            void server.close().catch(() => undefined);
          });

          await server.connect(transport);
          await transport.handleRequest(req, res, body);
          return;
        }

        const sessionId = Array.isArray(req.headers["mcp-session-id"])
          ? req.headers["mcp-session-id"][0]
          : req.headers["mcp-session-id"];

        if (sessionId && transports.has(sessionId)) {
          await transports.get(sessionId)!.handleRequest(req, res, body);
          return;
        }

        if (!sessionId && isInitializeRequest(body)) {
          let transport!: NodeStreamableHTTPServerTransport;
          const server = createMcpServer(options, (lookupSessionId) =>
            transports.get(lookupSessionId),
          );

          transport = new NodeStreamableHTTPServerTransport({
            sessionIdGenerator: () => randomUUID(),
            eventStore: createEventStore(),
            retryInterval: 5000,
            onsessioninitialized: (newSessionId) => {
              transports.set(newSessionId, transport);
              servers.set(newSessionId, server);
            },
          });

          transport.onclose = () => {
            const currentSessionId = transport.sessionId;
            if (currentSessionId) {
              transports.delete(currentSessionId);
            }
          };

          await server.connect(transport);
          await transport.handleRequest(req, res, body);
          return;
        }

        res.writeHead(400, { "Content-Type": "application/json" });
        res.end(
          JSON.stringify({
            jsonrpc: "2.0",
            error: {
              code: -32000,
              message: "Invalid or missing session ID",
            },
            id: null,
          }),
        );
        return;
      }

      if (req.method === "GET" || req.method === "DELETE") {
        const sessionId = Array.isArray(req.headers["mcp-session-id"])
          ? req.headers["mcp-session-id"][0]
          : req.headers["mcp-session-id"];

        if (!sessionId || !transports.has(sessionId)) {
          res.writeHead(400);
          res.end("Invalid or missing session ID");
          return;
        }

        await transports.get(sessionId)!.handleRequest(req, res);
        return;
      }

      res.writeHead(405);
      res.end("Method not allowed");
    } catch (error) {
      if (!res.headersSent) {
        res.writeHead(500, { "Content-Type": "application/json" });
        res.end(
          JSON.stringify({
            jsonrpc: "2.0",
            error: {
              code: -32603,
              message:
                error instanceof Error ? error.message : "Internal server error",
            },
            id: null,
          }),
        );
      }
    }
  });

  await new Promise<void>((resolve) => {
    httpServer.listen(0, "127.0.0.1", () => resolve());
  });

  const address = httpServer.address() as AddressInfo;
  const url = `http://127.0.0.1:${address.port}/mcp`;

  return {
    server: httpServer,
    url,
    stop: async () => {
      for (const transport of transports.values()) {
        try {
          await transport.close();
        } catch {
          // Best effort cleanup.
        }
      }

      for (const server of servers.values()) {
        await server.close().catch(() => undefined);
      }

      await new Promise<void>((resolve) => {
        httpServer.close(() => resolve());
      });
    },
  };
}
