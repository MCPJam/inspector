import { beforeEach, describe, expect, it, vi } from "vitest";
import { Hono } from "hono";

/**
 * MJ-001: what a hosted chat turn reports about a selected MCP server.
 *
 * The turn runs against the real client manager, the real hosted transport
 * and the real log collector; only the pinned socket is replaced by an
 * in-process upstream, and the model engine by a stub that streams whatever
 * the collector writes. The stored server config carries a custom header whose
 * value is a marker, and the upstream puts markers in its bodies and headers.
 */

type Upstream = (request: Request) => Response | Promise<Response>;

const {
  upstream,
  prepareChatV2Mock,
  handleMCPJamFreeChatModelMock,
  fetchHostRuntimeConfigMock,
  persistChatSessionToConvexMock,
} = vi.hoisted(() => {
  process.env.VITE_MCPJAM_HOSTED_MODE = "true";
  return {
    upstream: { current: undefined as Upstream | undefined },
    prepareChatV2Mock: vi.fn(),
    handleMCPJamFreeChatModelMock: vi.fn(),
    fetchHostRuntimeConfigMock: vi.fn(),
    persistChatSessionToConvexMock: vi.fn(),
  };
});

vi.mock("../../../utils/pinned-fetch.js", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("../../../utils/pinned-fetch.js")>();
  return {
    ...actual,
    createStreamingPinnedFetch: () =>
      (async (input: RequestInfo | URL, init?: RequestInit) => {
        if (!upstream.current) throw new Error("No upstream configured.");
        return upstream.current(new Request(input, init));
      }) as typeof fetch,
  };
});

vi.mock("../../../utils/chat-v2-orchestration.js", async (importOriginal) => {
  const actual =
    await importOriginal<
      typeof import("../../../utils/chat-v2-orchestration.js")
    >();
  return { ...actual, prepareChatV2: prepareChatV2Mock };
});

vi.mock("../../../utils/mcpjam-stream-handler.js", () => ({
  handleMCPJamFreeChatModel: handleMCPJamFreeChatModelMock,
  warnIfChatAbortSignalMissing: () => {},
}));

vi.mock("../../../utils/chat-ingestion.js", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("../../../utils/chat-ingestion.js")>();
  return {
    ...actual,
    persistChatSessionToConvex: persistChatSessionToConvexMock,
    pickEnrichmentHeaders: vi.fn(() => ({})),
  };
});

vi.mock("../../../utils/host-runtime-config.js", () => ({
  fetchHostRuntimeConfig: fetchHostRuntimeConfigMock,
}));

vi.mock("../apps.js", () => ({ default: new Hono() }));

vi.mock("@/shared/types", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/shared/types")>();
  return { ...actual, isMCPJamProvidedModel: vi.fn().mockReturnValue(true) };
});

import { MCPClientManager } from "@mcpjam/sdk";
import { WEB_CHAT_TOOL_LISTING_TIMEOUT_MS } from "@/shared/hosted-web-timeouts";
import { createWebTestApp, postJson } from "./helpers/test-app.js";

const MARKER = /UNEXPECTED_MARKER/;
const CONFIGURED_HEADERS = { "X-Tenant-Secret": "UNEXPECTED_MARKER_CONFIG" };
const EXTRA_HEADERS = { "x-upstream-trace": "UNEXPECTED_MARKER_HEADER" };

function json(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    headers: { "content-type": "application/json", ...EXTRA_HEADERS },
  });
}

/** An answer that is not MCP: 405 with an HTML page. */
const htmlRejection: Upstream = () =>
  new Response("<html><body>UNEXPECTED_MARKER_BODY</body></html>", {
    status: 405,
    headers: { "content-type": "text/html", ...EXTRA_HEADERS },
  });

/** A working MCP server with one tool. */
const mcpServer: Upstream = async (request) => {
  if (request.method !== "POST") {
    return new Response(null, { status: 405, headers: EXTRA_HEADERS });
  }
  const message = (await request.json().catch(() => undefined)) as any;
  if (message?.method === "initialize") {
    return json({
      jsonrpc: "2.0",
      id: message.id,
      result: {
        protocolVersion: "2025-06-18",
        capabilities: { tools: {} },
        serverInfo: { name: "fixture", version: "1.0.0" },
      },
    });
  }
  if (message?.id === undefined) {
    return new Response(null, { status: 202, headers: EXTRA_HEADERS });
  }
  if (message.method === "tools/list") {
    return json({
      jsonrpc: "2.0",
      id: message.id,
      result: { tools: [{ name: "search", inputSchema: { type: "object" } }] },
    });
  }
  return json({
    jsonrpc: "2.0",
    id: message.id,
    error: { code: -32601, message: "Method not found" },
  });
};

const body = {
  projectId: "project-1",
  selectedServerIds: ["server-1"],
  selectedServerNames: ["Fixture"],
  messages: [
    { id: "u1", role: "user", parts: [{ type: "text", text: "hello" }] },
  ],
  model: { id: "openai/gpt-5-mini", provider: "openai", name: "GPT-5 Mini" },
};

beforeEach(() => {
  vi.clearAllMocks();
  process.env.CONVEX_HTTP_URL = "https://example.convex.site";
  fetchHostRuntimeConfigMock.mockResolvedValue({
    ok: true,
    config: { selectedServerIds: ["server-1"] },
  });
  // The turn's preparation lists the selected servers' tools, as the real
  // orchestration does, so the connection and its exchanges happen here.
  prepareChatV2Mock.mockImplementation(async (args: any) => {
    await args.mcpClientManager.getToolsForAiSdk(args.selectedServers);
    return { allTools: {}, enhancedSystemPrompt: "system" };
  });
  // The engine streams what the turn's writer is handed.
  handleMCPJamFreeChatModelMock.mockImplementation(async (options: any) => {
    const parts: unknown[] = [];
    options.onStreamWriterReady?.({
      write: (part: unknown) => parts.push(part),
    });
    options.onStreamComplete?.();
    return new Response(JSON.stringify(parts), { status: 200 });
  });
  global.fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    if (url.endsWith("/web/authorize-project")) {
      return new Response(JSON.stringify({ ok: true }), { status: 200 });
    }
    if (url.endsWith("/web/authorize-batch")) {
      const { serverIds = [] } = JSON.parse(String(init?.body ?? "{}"));
      return new Response(
        JSON.stringify({
          results: Object.fromEntries(
            serverIds.map((serverId: string) => [
              serverId,
              {
                ok: true,
                role: "member",
                accessLevel: "project_member",
                permissions: { chatOnly: false },
                serverConfig: {
                  transportType: "http",
                  url: "https://mcp.example.test/mcp",
                  headers: CONFIGURED_HEADERS,
                  useOAuth: false,
                },
              },
            ]),
          ),
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    }
    throw new Error(`Unexpected fetch: ${url}`);
  }) as typeof fetch;
});

describe("hosted chat turn (MJ-001)", () => {
  it("reports a server that is not MCP without its answer", async () => {
    upstream.current = htmlRejection;
    const { app, token } = createWebTestApp();
    const response = await postJson(app, "/api/web/chat-v2", body, token);
    expect(response.status).toBeGreaterThanOrEqual(400);
    const payload = await response.text();
    expect(payload).not.toMatch(MARKER);
    expect(JSON.parse(payload)._httpLogs?.length).toBeGreaterThan(0);
  });

  it("streams exchange log parts without a stored header value or extra headers", async () => {
    upstream.current = mcpServer;
    const { app, token } = createWebTestApp();
    const response = await postJson(app, "/api/web/chat-v2", body, token);
    expect(response.status).toBe(200);
    const parts = (await response.json()) as any[];
    const httpParts = parts.filter((part) => part.type === "data-http-log");
    expect(httpParts.length).toBeGreaterThan(0);
    expect(JSON.stringify(parts)).not.toMatch(MARKER);
    for (const part of httpParts) {
      const headers = part.data.exchange.request.headers;
      expect(headers["x-tenant-secret"]).toBe("<redacted>");
    }
    // Received frames are the server's own MCP answers, and stay whole.
    expect(
      parts.some(
        (part) =>
          part.type === "data-rpc-log" &&
          part.data.direction === "receive" &&
          part.data.message.result?.tools,
      ),
    ).toBe(true);
  });

  it("fails a hung server's tool listing with our own 424 and drops the connect", async () => {
    // A server that accepts the request and never answers. The abort is the
    // evidence the stuck connect was cancelled rather than left to run out
    // the manager's own per-request timeout and retries.
    let aborted = false;
    upstream.current = (request) =>
      new Promise<Response>((_resolve, reject) => {
        request.signal.addEventListener("abort", () => {
          aborted = true;
          reject(request.signal.reason);
        });
      });
    const disconnectAll = vi.spyOn(
      MCPClientManager.prototype,
      "disconnectAllServers",
    );
    const { prepareChatV2 } = await vi.importActual<
      typeof import("../../../utils/chat-v2-orchestration.js")
    >("../../../utils/chat-v2-orchestration.js");
    prepareChatV2Mock.mockImplementation((args: any) => {
      // The hosted turn asks for the real budget; shortened here so the test
      // does not wait 30 s.
      expect(args.toolListingTimeoutMs).toBe(WEB_CHAT_TOOL_LISTING_TIMEOUT_MS);
      return prepareChatV2({ ...args, toolListingTimeoutMs: 50 });
    });

    const { app, token } = createWebTestApp();
    const response = await postJson(app, "/api/web/chat-v2", body, token);

    expect(response.status).toBe(424);
    const payload = (await response.json()) as any;
    expect(payload.code).toBe("TIMEOUT");
    expect(payload.message).toMatch(/MCP server ".*" timed out/);
    expect(disconnectAll).toHaveBeenCalled();
    expect(aborted).toBe(true);
    expect(handleMCPJamFreeChatModelMock).not.toHaveBeenCalled();
    disconnectAll.mockRestore();
  });
});
