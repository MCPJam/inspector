/**
 * Wire-level regression for an unpinned (Auto) plugin client's form claims.
 *
 * The request runtime arms BOTH form services before connect, because the
 * era is only known after negotiation: the OpenAI legacy handler
 * (`openai/elicitation/create`) and the MRTR input collector. Neither answers
 * a STANDARD legacy `elicitation/create`, so the 2025 `initialize` must not
 * claim standard form support — a server relying on that claim would get
 * `-32601` mid tool call. The 2026 era keeps the claim: the MRTR collector
 * answers it there.
 *
 * Executor-selection tests mock the manager and so cannot see this; here the
 * runtime's own capability set and handlers drive the real `MCPClientManager`
 * against loopback HTTP servers.
 */
import http from "node:http";
import { randomUUID } from "node:crypto";
import type { AddressInfo } from "node:net";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import type { Context } from "hono";
import {
  acceptedContent,
  createMcpHandler,
  inputRequired,
  McpServer,
} from "@modelcontextprotocol/server";
import {
  NodeStreamableHTTPServerTransport,
  toNodeHandler,
} from "@modelcontextprotocol/node";
import { MCPClientManager } from "@mcpjam/sdk";
import {
  pluginHostBindingDigest,
  pluginServerBindingDigest,
} from "../bindings";

const f = vi.hoisted(() => ({
  query: vi.fn(),
  url: "",
  managers: [] as { disconnectAllServers: () => Promise<void> }[],
  collector: vi.fn(),
}));

vi.mock("../../evals/route-helpers.js", () => ({
  createConvexClient: () => ({ query: f.query }),
}));
vi.mock("../owned-mrtr.js", async (original) => {
  const actual = await original<typeof import("../owned-mrtr.js")>();
  return {
    ...actual,
    createOwnedPluginMrtr: (
      deps: Parameters<typeof actual.createOwnedPluginMrtr>[0],
    ) => ({ ...actual.createOwnedPluginMrtr(deps), collector: f.collector }),
  };
});
const identity = () => ({
  serverId: "server",
  credentialId: "saved-credential",
  credentialAuthorizedAt: 100,
  config: {
    transportType: "http",
    url: f.url,
    credentialConfigurationId: "a".repeat(64),
  },
});
// The real hosted builder, reduced to what reaches the wire: a real manager
// with the runtime's extension handlers, and the runtime's capability set as
// the server config's EXACT `clientCapabilities` (as `createAuthorizedManager`
// stamps it). No protocol pin: Auto negotiation.
vi.mock("../../../routes/web/auth.js", () => ({
  projectServerSchema: z.object({
    projectId: z.string(),
    serverId: z.string(),
  }),
  createManualHostedConnection: async (
    _c: unknown,
    _body: unknown,
    _schema: unknown,
    options: {
      extensionRequestHandlers?: ConstructorParameters<
        typeof MCPClientManager
      >[1] extends infer O
        ? O extends { extensionRequestHandlers?: infer H }
          ? H
          : never
        : never;
      hostConfig: { clientCapabilities: Record<string, unknown> };
    },
  ) => {
    const manager = new MCPClientManager(
      {},
      {
        lazyConnect: true,
        extensionRequestHandlers: options.extensionRequestHandlers,
      },
    );
    f.managers.push(manager);
    const caps = options.hostConfig.clientCapabilities;
    return {
      manager,
      authorizedServerConfigs: {
        server: {
          url: f.url,
          capabilities: caps,
          clientCapabilities: caps,
          timeout: 10_000,
        },
      },
      authorizedServerIdentities: { server: identity() },
    };
  },
}));

import { admitPluginWorkspace } from "../admission";
import { createPluginRequestRuntime } from "../request-runtime";
import { pluginConnectionPool } from "../connection-pool";

const formSchema = {
  type: "object" as const,
  properties: { answer: { type: "string" as const } },
  required: ["answer"],
};

interface Served {
  url: string;
  /** `params.capabilities` of every `initialize` the server received. */
  initialize: Record<string, unknown>[];
  /** Client JSON-RPC responses to server-to-client requests. */
  replies: { id: unknown; result?: unknown; error?: { code?: number } }[];
  close: () => Promise<void>;
}

async function readBody(req: http.IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(Buffer.from(chunk));
  const text = Buffer.concat(chunks).toString("utf8");
  return text ? JSON.parse(text) : undefined;
}

/**
 * A 2025-only stateful Streamable HTTP server: it answers the modern
 * `server/discover` probe with `-32601` (Auto falls back to `initialize`), and
 * its tool asks a STANDARD `elicitation/create` form exactly when the client
 * declared form support — the behavior of any server that trusts the claim.
 */
async function serveLegacy(): Promise<Served> {
  const served: Omit<Served, "url" | "close"> = { initialize: [], replies: [] };
  const transports = new Map<string, NodeStreamableHTTPServerTransport>();
  const build = () => {
    const server = new McpServer(
      { name: "legacy-form-fixture", version: "1.0.0" },
      { capabilities: { tools: {} } },
    );
    server.registerTool(
      "app",
      { description: "Asks a form when the client claims one." },
      async (ctx) => {
        if (!server.server.getClientCapabilities()?.elicitation) {
          return { content: [{ type: "text" as const, text: "no-form" }] };
        }
        const result = await ctx.mcpReq.elicitInput({
          mode: "form",
          message: "Answer?",
          requestedSchema: formSchema,
        });
        return {
          content: [{ type: "text" as const, text: `form:${result.action}` }],
        };
      },
    );
    return server;
  };
  const httpServer = http.createServer(async (req, res) => {
    const sessionId = req.headers["mcp-session-id"] as string | undefined;
    if (req.method !== "POST") {
      const transport = sessionId ? transports.get(sessionId) : undefined;
      if (!transport) {
        res.writeHead(405).end();
        return;
      }
      await transport.handleRequest(req, res);
      return;
    }
    const body = (await readBody(req)) as {
      id?: unknown;
      method?: string;
      params?: { capabilities?: Record<string, unknown> };
      result?: unknown;
      error?: { code?: number };
    };
    if (body?.method === "server/discover") {
      res.writeHead(200, { "content-type": "application/json" }).end(
        JSON.stringify({
          jsonrpc: "2.0",
          id: body.id,
          error: { code: -32601, message: "Method not found" },
        }),
      );
      return;
    }
    if (body?.method === "initialize") {
      served.initialize.push(body.params?.capabilities ?? {});
      const server = build();
      const transport: NodeStreamableHTTPServerTransport =
        new NodeStreamableHTTPServerTransport({
          sessionIdGenerator: () => randomUUID(),
          onsessioninitialized: (id) => {
            transports.set(id, transport);
          },
        });
      await server.connect(transport);
      await transport.handleRequest(req, res, body);
      return;
    }
    if (body && !body.method && body.id !== undefined) {
      served.replies.push({
        id: body.id,
        result: body.result,
        error: body.error,
      });
    }
    const transport = sessionId ? transports.get(sessionId) : undefined;
    if (!transport) {
      res.writeHead(400).end();
      return;
    }
    await transport.handleRequest(req, res, body);
  });
  await new Promise<void>((done) => httpServer.listen(0, "127.0.0.1", done));
  return {
    ...served,
    url: `http://127.0.0.1:${(httpServer.address() as AddressInfo).port}/mcp`,
    close: async () => {
      await Promise.allSettled(
        [...transports.values()].map((transport) => transport.close()),
      );
      httpServer.closeAllConnections();
      await new Promise<void>((done) => httpServer.close(() => done()));
    },
  };
}

/** A dual-era server (2026-07-28 preferred) whose tool needs one MRTR form. */
async function serveModern(): Promise<Served> {
  const handler = createMcpHandler(() => {
    const server = new McpServer(
      { name: "modern-form-fixture", version: "1.0.0" },
      { capabilities: { tools: {} } },
    );
    server.registerTool(
      "app",
      { description: "Asks one MRTR form." },
      async (ctx) => {
        const answered = acceptedContent<{ answer: string }>(
          ctx.mcpReq.inputResponses,
          "q",
        );
        if (!answered) {
          return inputRequired({
            inputRequests: {
              q: inputRequired.elicit({
                message: "Answer?",
                requestedSchema: formSchema,
              }),
            },
            requestState: "state-1",
          });
        }
        return {
          content: [{ type: "text" as const, text: `form:${answered.answer}` }],
        };
      },
    );
    return server;
  });
  const httpServer = http.createServer(toNodeHandler(handler));
  await new Promise<void>((done) => httpServer.listen(0, "127.0.0.1", done));
  return {
    initialize: [],
    replies: [],
    url: `http://127.0.0.1:${(httpServer.address() as AddressInfo).port}/mcp`,
    close: async () => {
      httpServer.closeAllConnections();
      await new Promise<void>((done) => httpServer.close(() => done()));
    },
  };
}

const host = {
  hostId: "host",
  modelId: "model",
  systemPrompt: "",
  temperature: 0,
  requireToolApproval: false,
  hostStyle: "chatgpt",
  executionScope: { kind: "project", projectId: "project" },
  // The Codex and ChatGPT templates pin no protocol: Auto negotiation.
  harness: "codex",
  mcpProfile: {},
};

async function autoRuntime() {
  const admission = await admitPluginWorkspace({
    projectId: "project",
    bearer: "fixture",
    descriptor: { version: 1, workspaceId: "workspace" },
  });
  return createPluginRequestRuntime(
    {} as Context,
    admission,
    "fixture",
    { hostId: "host", serverId: "server" },
    {
      hostRevision: pluginHostBindingDigest(host),
      serverIdentity: { kind: "standalone" as const, serverId: "server" },
      owner: {
        bindingId: pluginServerBindingDigest(identity()),
        workspaceId: "workspace",
      },
    } as Parameters<typeof createPluginRequestRuntime>[4],
  );
}

let served: Served | undefined;
beforeEach(async () => {
  await pluginConnectionPool.clear();
  f.managers.length = 0;
  f.collector.mockReset();
  f.query.mockImplementation(async (_: unknown, args: any) => ({
    actorId: "actor",
    projectId: "project",
    ...(args.hostId ? { hostConfig: host } : {}),
    serverBindings: args.serverIds?.map((serverId: string) => ({
      kind: "standalone",
      serverId,
    })),
  }));
});
afterEach(async () => {
  await pluginConnectionPool.clear();
  await Promise.allSettled(f.managers.map((m) => m.disconnectAllServers()));
  await served?.close();
  served = undefined;
});

describe("an unpinned (Auto) plugin client's form claims on the wire", () => {
  it("Auto → 2025: claims no standard form support nothing answers, so no tool call dies with -32601", async () => {
    served = await serveLegacy();
    f.url = served.url;
    const live = await autoRuntime();
    const resolved = await live.resolve("app", new AbortController().signal);
    expect(resolved.protocolVersion).toBe("2025-11-25");
    expect(resolved.transport).toBe("legacy");

    // The legacy handshake carried the OpenAI claim (its handler answers it
    // there) but no standard `elicitation`: no standard handler is installed.
    expect(served.initialize).toHaveLength(1);
    const advertised = served.initialize[0]!;
    expect(advertised.extensions).toMatchObject({
      "openai/elicitation": { form: {} },
    });
    expect(advertised.elicitation).toBeUndefined();

    const result = (await resolved.manager.executeTool(
      "server",
      "app",
      {},
    )) as {
      isError?: boolean;
      content: { text?: string }[];
    };
    expect(result.isError).not.toBe(true);
    expect(result.content[0]?.text).toBe("no-form");
    // No standard form request reached the client, so none was refused.
    expect(served.replies.filter((r) => r.error?.code === -32601)).toEqual([]);
    expect(f.collector).not.toHaveBeenCalled();
    await live.release();
  });

  it("Auto → 2026-07-28: keeps modern form support and answers through the MRTR collector", async () => {
    served = await serveModern();
    f.url = served.url;
    f.collector.mockImplementation(
      async ({ inputRequests }: { inputRequests: Record<string, unknown> }) =>
        Object.fromEntries(
          Object.keys(inputRequests).map((key) => [
            key,
            { action: "accept", content: { answer: "modern" } },
          ]),
        ),
    );
    const live = await autoRuntime();
    const resolved = await live.resolve("app", new AbortController().signal);
    expect(resolved.protocolVersion).toBe("2026-07-28");
    expect(resolved.transport).toBe("mrtr");

    const caps = (resolved.manager.getInitializationInfo("server")
      ?.clientCapabilities ?? {}) as Record<string, unknown>;
    expect(caps.elicitation).toEqual({ form: {} });
    // The OpenAI claim is legacy-only and withheld on this era.
    expect(
      (caps.extensions as Record<string, unknown> | undefined)?.[
        "openai/elicitation"
      ],
    ).toBeUndefined();

    // The server embeds a form only for a client that declared form support
    // on the request envelope (otherwise -32021); the collector answers it.
    const result = (await resolved.manager.executeTool(
      "server",
      "app",
      {},
    )) as {
      isError?: boolean;
      content: { text?: string }[];
    };
    expect(result.isError).not.toBe(true);
    expect(result.content[0]?.text).toBe("form:modern");
    expect(f.collector).toHaveBeenCalledOnce();
    await live.release();
  });
});
