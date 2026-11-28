/**
 * An in-process "real" MCP server for the mock tests, and the adapter that
 * reaches it as the Inspector's route will: through `MCPClientManager`.
 */
import {
  createMcpHandler,
  inputRequired,
  McpServer,
} from "@modelcontextprotocol/server";
import type {
  McpHttpHandler,
  ServerContext,
} from "@modelcontextprotocol/server";
import { z } from "zod";
import { MCPClientManager } from "../../mcp-client-manager/index.js";
import type { McpProtocolVersion } from "../../mcp-client-manager/mcp-protocol-version.js";
import type {
  MockForwardDecision,
  MockListChangedKind,
  MockRealServer,
} from "../real-server.js";

export interface RealCalls {
  /** Every tools/call the real server received: name and arguments. */
  calls: Array<{ name: string; args: Record<string, unknown> }>;
  /** The tool listing the real server returns; tests reassign it to change the server. */
  hideTools: Set<string>;
  /** Every forward the mock asked the host to allow. */
  asked?: Array<{ kind: string; name: string }>;
  /** Answers each forward; without it every forward is allowed. */
  decide?: () => MockForwardDecision | Promise<MockForwardDecision>;
  /** Serve resources only, as a server with no tools does. */
  resourcesOnly?: boolean;
  /** Also serve one prompt, `greet`, so the mock has a real prompt to pass through or edit. */
  withPrompts?: boolean;
  /** Also serve `extra` (a result with a field the spec does not name) and `ask` (a question on 2026-07-28). */
  withProtocolTools?: boolean;
  /** Declare resource subscriptions and record each subscribe and unsubscribe. */
  withSubscribe?: boolean;
  subscribed?: Array<{ method: string; uri: string }>;
  /** Declare completions, answering `real-1`, `real-2`, and record each request. */
  withCompletions?: boolean;
  completed?: Array<Record<string, unknown>>;
}

function registerTools(server: McpServer, state: RealCalls): void {
  const registered: Record<string, { disable(): void }> = {};
  registered.echo = server.registerTool(
    "echo",
    {
      description: "Echoes the message.",
      inputSchema: { message: z.string() },
    },
    async (args) => {
      state.calls.push({ name: "echo", args });
      return {
        content: [
          { type: "text" as const, text: `echo: ${String(args.message)}` },
        ],
      };
    }
  );
  registered.add = server.registerTool(
    "add",
    {
      description: "Adds two numbers.",
      inputSchema: {
        a: z.number(),
        b: z.number(),
        mode: z.string().optional().describe("Rounding mode."),
      },
      annotations: { readOnlyHint: true },
    },
    async (args) => {
      state.calls.push({ name: "add", args });
      return {
        content: [
          {
            type: "text" as const,
            text: `${args.a + args.b} mode=${String(args.mode)}`,
          },
        ],
      };
    }
  );
  registered.working = server.registerTool(
    "working",
    {
      description: "Reports progress, logs, then changes its list.",
      inputSchema: {},
    },
    async (_args, ctx) => {
      state.calls.push({ name: "working", args: {} });
      const token = ctx.mcpReq._meta?.progressToken;
      if (token !== undefined) {
        await ctx.mcpReq.notify({
          method: "notifications/progress",
          params: {
            progressToken: token,
            progress: 1,
            total: 2,
            message: "half",
          },
        });
      }
      await ctx.mcpReq.log("info", "step one");
      await ctx.mcpReq.notify({
        method: "notifications/tools/list_changed",
      });
      return { content: [{ type: "text" as const, text: "done" }] };
    }
  );
  if (state.withProtocolTools) registerProtocolTools(server, registered);
  // A tool the test removed from the real server is neither listed nor callable.
  for (const name of state.hideTools) registered[name]?.disable();
}

function registerProtocolTools(
  server: McpServer,
  registered: Record<string, { disable(): void }>
): void {
  registered.extra = server.registerTool(
    "extra",
    {
      description: "Answers with a field the spec does not name.",
      inputSchema: {},
    },
    async () =>
      ({
        content: [{ type: "text" as const, text: "extra" }],
        vendorField: { kept: true },
      }) as never
  );
  // Asks the person's name through the 2026-07-28 multi round trip, then greets by it.
  registered.ask = server.registerTool(
    "ask",
    { description: "Asks for a name, then greets.", inputSchema: {} },
    (async (_args: unknown, ctx: ServerContext) => {
      const reply = ctx.mcpReq.inputResponses?.name as
        { action?: string; content?: { who?: string } } | undefined;
      if (!reply) {
        return inputRequired({
          inputRequests: {
            name: inputRequired.elicit({
              message: "Who are you?",
              requestedSchema: {
                type: "object",
                properties: { who: { type: "string" } },
              },
            }),
          },
          requestState: "real-state",
        });
      }
      return {
        content: [
          {
            type: "text" as const,
            text: `hello ${String(reply.content?.who)} (${ctx.mcpReq.requestState()})`,
          },
        ],
      };
    }) as never
  );
}

export function buildRealHandler(state: RealCalls): McpHttpHandler {
  return createMcpHandler(
    () => {
      const server = new McpServer(
        { name: "real-fixture", version: "9.9.9" },
        {
          capabilities: {
            ...(state.resourcesOnly
              ? { resources: {} }
              : { tools: {}, resources: {}, logging: {} }),
            ...(state.withPrompts && { prompts: {} }),
            ...(state.withCompletions && { completions: {} }),
            ...(state.withSubscribe && { resources: { subscribe: true } }),
          },
          instructions: "Real instructions.",
        }
      );
      if (!state.resourcesOnly) registerTools(server, state);
      if (state.withSubscribe) {
        for (const method of [
          "resources/subscribe",
          "resources/unsubscribe",
        ] as const) {
          server.server.setRequestHandler(method, async (request) => {
            state.subscribed?.push({ method, uri: request.params.uri });
            return {};
          });
        }
      }
      if (state.withCompletions) {
        server.server.setRequestHandler(
          "completion/complete",
          async (request) => {
            state.completed?.push(request.params as Record<string, unknown>);
            return { completion: { values: ["real-1", "real-2"] } };
          }
        );
      }
      if (state.withPrompts) {
        server.registerPrompt(
          "greet",
          {
            description: "Greets someone.",
            argsSchema: { who: z.string() },
          },
          ({ who }) => ({
            messages: [
              {
                role: "user" as const,
                content: { type: "text" as const, text: `Greet ${who}.` },
              },
            ],
          })
        );
      }
      server.registerResource(
        "greeting",
        "test://greeting",
        { mimeType: "text/plain" },
        async () => ({
          contents: [
            { uri: "test://greeting", text: "hello", mimeType: "text/plain" },
          ],
        })
      );
      return server;
    },
    { legacy: "stateless" }
  );
}

/** Connects a manager to the fixture and wraps it as the mock's real server. */
export async function connectRealServer(
  handler: McpHttpHandler,
  state?: RealCalls,
  /** Pin the connection to one revision, as a host does when the caller's revision is pinned. */
  mcpProtocolVersion?: McpProtocolVersion
): Promise<{ real: MockRealServer; close: () => Promise<void> }> {
  const manager = new MCPClientManager();
  const id = "real";
  await manager.connectToServer(id, {
    url: "http://real.local/mcp",
    ...(mcpProtocolVersion && { mcpProtocolVersion }),
    baseFetch: (input, init) =>
      handler.fetch(new Request(input as string | URL, init)),
  });
  const real: MockRealServer = {
    describe: async () => {
      const info = manager.getInitializationInfo(id);
      return {
        capabilities: info?.serverCapabilities ?? {},
        ...(info?.serverVersion && {
          serverInfo: {
            name: info.serverVersion.name,
            version: info.serverVersion.version,
          },
        }),
        ...(info?.instructions !== undefined && {
          instructions: info.instructions,
        }),
      };
    },
    authorizeForward: async (request) => {
      state?.asked?.push(
        request.kind === "tool"
          ? { kind: "tool", name: request.realTool }
          : { kind: "request", name: request.method }
      );
      return (await state?.decide?.()) ?? { allowed: true };
    },
    listTools: async (options) => {
      const tools = [];
      let cursor: string | undefined;
      do {
        const page = await manager.listTools(
          id,
          cursor ? { cursor } : undefined,
          { signal: options?.signal, cacheMode: "bypass" }
        );
        tools.push(...page.tools);
        cursor = page.nextCursor;
      } while (cursor);
      return tools;
    },
    callTool: async ({
      name,
      arguments: args,
      signal,
      logLevel,
      onProgress,
      onLog,
    }) => {
      if (logLevel) {
        // The manager keeps one level per connection: per request on 2026-07-28, once per session before it.
        if (manager.getLoggingMechanism(id) === "per-request-meta")
          manager.setPerRequestLogLevel(id, logLevel);
        else await manager.setLoggingLevel(id, logLevel);
      }
      const handlers: Array<() => void> = [];
      if (onLog) {
        const logHandler = (n: { params?: Record<string, unknown> }) =>
          onLog({
            level: n.params?.level as never,
            data: n.params?.data,
            logger: n.params?.logger as string | undefined,
          });
        manager.addNotificationHandler(
          id,
          "notifications/message",
          logHandler as never
        );
        handlers.push(() =>
          manager.removeNotificationHandler(
            id,
            "notifications/message",
            logHandler as never
          )
        );
      }
      try {
        return (await manager.executeTool(id, name, args, {
          signal,
          ...(onProgress && { onprogress: onProgress }),
        })) as never;
      } finally {
        for (const undo of handlers) undo();
      }
    },
    request: async (request, options) => {
      const client = manager.getManagedClient(id);
      if (!client) throw new Error("The real server is not connected.");
      return (await client.request(
        { method: request.method, params: request.params } as never,
        options
      )) as Record<string, unknown>;
    },
    onListChanged: (handler) => {
      const methods: Array<[string, MockListChangedKind]> = [
        ["notifications/tools/list_changed", "tools"],
      ];
      const subscribed = methods.map(([method, kind]) => {
        const fn = () => handler(kind);
        manager.addNotificationHandler(id, method as never, fn as never);
        return () =>
          manager.removeNotificationHandler(id, method as never, fn as never);
      });
      return () => subscribed.forEach((undo) => undo());
    },
  };
  return { real, close: () => manager.disconnectAllServers() };
}
