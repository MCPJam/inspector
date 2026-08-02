import { MCPConformanceTest } from "../../src/mcp-conformance/index.js";
import { runTransportChecks } from "../../src/mcp-conformance/checks/transport.js";
import { TOOL_CHECKS } from "../../src/mcp-conformance/checks/tools.js";
import * as operations from "../../src/operations.js";

vi.mock("../../src/operations.js", () => ({
  listPrompts: vi.fn(),
  listResources: vi.fn(),
  listTools: vi.fn(),
  withEphemeralClient: vi.fn(),
}));

const mockedOperations = vi.mocked(operations);

function jsonResponse(body: unknown, init: ResponseInit = {}): Response {
  const headers = new Headers(init.headers);
  if (!headers.has("content-type")) {
    headers.set("content-type", "application/json");
  }

  return new Response(JSON.stringify(body), {
    ...init,
    headers,
  });
}

function sseResponse(chunks: Array<string | Error>): Response {
  const encoder = new TextEncoder();

  return new Response(
    new ReadableStream<Uint8Array>({
      start(controller) {
        for (const chunk of chunks) {
          if (chunk instanceof Error) {
            controller.error(chunk);
            return;
          }

          controller.enqueue(encoder.encode(chunk));
        }

        controller.close();
      },
    }),
    {
      status: 200,
      headers: {
        "content-type": "text/event-stream",
      },
    },
  );
}

function createTransportContext(fetchFn: typeof fetch) {
  return {
    config: {
      serverUrl: "https://example.com/mcp",
      checkTimeout: 250,
      categories: [],
      fetchFn,
      clientName: "mcpjam-sdk-conformance",
      era: "legacy" as const,
    },
    serverUrl: "https://example.com/mcp",
    fetchFn,
  };
}

describe("mcp conformance unit checks", () => {
  afterEach(() => {
    vi.resetAllMocks();
  });

  it("accepts tools whose inputSchema omits a top-level type", async () => {
    const check = TOOL_CHECKS.find(
      (candidate) => candidate.id === "tools-input-schemas-valid",
    );

    if (!check) {
      throw new Error("tools-input-schemas-valid check is unavailable");
    }

    const result = await check.run({
      manager: {
        listTools: vi.fn().mockResolvedValue({
          tools: [{ name: "echo", inputSchema: {} }],
        }),
      } as any,
      serverId: "server-1",
    } as any);

    expect(result.status).toBe("passed");
  });

  describe("tools-x-mcp-header-declarations-valid", () => {
    const check = () => {
      const found = TOOL_CHECKS.find(
        (candidate) => candidate.id === "tools-x-mcp-header-declarations-valid",
      );
      if (!found) {
        throw new Error(
          "tools-x-mcp-header-declarations-valid check is unavailable",
        );
      }
      return found;
    };

    const runAgainst = (tools: unknown[]) =>
      check().run({
        manager: { listTools: vi.fn().mockResolvedValue({ tools }) } as any,
        serverId: "server-1",
      } as any);

    it("passes a server whose tools declare nothing", async () => {
      const result = await runAgainst([
        { name: "echo", inputSchema: { type: "object", properties: {} } },
      ]);
      expect(result.status).toBe("passed");
      expect(result.details?.declaringTools).toBe(0);
    });

    it("passes valid declarations and counts the declaring tools", async () => {
      const result = await runAgainst([
        {
          name: "query",
          inputSchema: {
            type: "object",
            properties: {
              region: { type: "string", "x-mcp-header": "Region" },
            },
          },
        },
        { name: "echo", inputSchema: { type: "object" } },
      ]);
      expect(result.status).toBe("passed");
      expect(result.details?.declaringTools).toBe(1);
    });

    it("fails a declaration parked under oneOf (not statically reachable)", async () => {
      const result = await runAgainst([
        {
          name: "query",
          inputSchema: {
            type: "object",
            properties: {
              region: {
                oneOf: [{ type: "string", "x-mcp-header": "Region" }],
              },
            },
          },
        },
      ]);
      expect(result.status).toBe("failed");
      expect(result.error?.message).toMatch(/statically reachable/);
      expect(result.error?.message).toMatch(/MUST treat those tool definitions as invalid/);
      expect(result.details?.violations).toEqual([
        { tool: "query", reason: expect.stringContaining("statically reachable") },
      ]);
    });

    it("fails a header name that is not an RFC 9110 token", async () => {
      const result = await runAgainst([
        {
          name: "query",
          inputSchema: {
            type: "object",
            properties: {
              region: { type: "string", "x-mcp-header": "Bad Header" },
            },
          },
        },
      ]);
      expect(result.status).toBe("failed");
      expect(result.error?.message).toMatch(/RFC 9110 token/);
    });

    it("fails a non-primitive declared property", async () => {
      const result = await runAgainst([
        {
          name: "query",
          inputSchema: {
            type: "object",
            properties: {
              region: { type: "object", "x-mcp-header": "Region" },
            },
          },
        },
      ]);
      expect(result.status).toBe("failed");
      expect(result.error?.message).toMatch(/primitive-typed properties/);
    });

    it("fails two declarations that collide case-insensitively", async () => {
      const result = await runAgainst([
        {
          name: "query",
          inputSchema: {
            type: "object",
            properties: {
              a: { type: "string", "x-mcp-header": "Region" },
              b: { type: "string", "x-mcp-header": "region" },
            },
          },
        },
      ]);
      expect(result.status).toBe("failed");
      expect(result.error?.message).toMatch(/case-insensitively unique/);
    });

    it("names every offending tool, not just the first", async () => {
      const result = await runAgainst([
        {
          name: "one",
          inputSchema: {
            type: "object",
            properties: { a: { type: "string", "x-mcp-header": "Bad Header" } },
          },
        },
        {
          name: "two",
          inputSchema: {
            type: "object",
            properties: { b: { type: "array", "x-mcp-header": "Other" } },
          },
        },
      ]);
      expect(result.status).toBe("failed");
      expect(
        (result.details?.violations as Array<{ tool: string }>).map((v) => v.tool),
      ).toEqual(["one", "two"]);
    });

    it("bypasses the response cache so it judges what the server publishes now", async () => {
      const listTools = vi.fn().mockResolvedValue({ tools: [] });
      await check().run({
        manager: { listTools } as any,
        serverId: "server-1",
      } as any);
      expect(listTools).toHaveBeenCalledWith("server-1", undefined, {
        cacheMode: "bypass",
      });
    });
  });

  it("does not abort core-only runs when optional list methods fail during setup", async () => {
    mockedOperations.withEphemeralClient.mockImplementation(
      async (_config, fn) =>
        fn(
          {
            getClient: vi.fn().mockReturnValue({}),
            getManagedClient: vi.fn().mockReturnValue({}),
            getInitializationInfo: vi.fn().mockReturnValue({
              protocolVersion: "2025-11-25",
              transport: "streamable-http",
              serverCapabilities: {},
              serverVersion: { name: "test-server", version: "1.0.0" },
            }),
            listResourceTemplates: jest
              .fn()
              .mockRejectedValue(new Error("resources/templates unsupported")),
          } as any,
          "server-1",
        ),
    );
    mockedOperations.listTools.mockRejectedValue(
      new Error("tools/list unsupported"),
    );
    mockedOperations.listPrompts.mockRejectedValue(
      new Error("prompts/list unsupported"),
    );
    mockedOperations.listResources.mockRejectedValue(
      new Error("resources/list unsupported"),
    );

    const result = await new MCPConformanceTest({
      serverUrl: "https://example.com/mcp",
      checkIds: ["server-initialize"],
    }).run();

    expect(result.passed).toBe(true);
    expect(result.checks).toHaveLength(1);
    expect(result.checks[0]).toMatchObject({
      id: "server-initialize",
      status: "passed",
    });
  });

  it("reports protocol checks in the protocol category", async () => {
    mockedOperations.withEphemeralClient.mockImplementation(
      async (_config, fn) =>
        fn(
          {
            getManagedClient: vi.fn().mockReturnValue({}),
            getInitializationInfo: vi.fn().mockReturnValue({
              protocolVersion: "2025-11-25",
            }),
          } as any,
          "server-1",
        ),
    );
    const fetchFn = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body ?? "{}")) as { method?: string };

      if (body.method === "initialize") {
        return jsonResponse(
          { jsonrpc: "2.0", id: 1, result: { protocolVersion: "2025-11-25" } },
          {
            headers: {
              "mcp-session-id": "session-1",
            },
          },
        );
      }

      return jsonResponse({
        jsonrpc: "2.0",
        id: 99,
        error: {
          code: -32601,
          message: "Method not found",
        },
      });
    }) as typeof fetch;

    const result = await new MCPConformanceTest({
      serverUrl: "https://example.com/mcp",
      checkIds: ["protocol-invalid-method-error"],
      fetchFn,
    }).run();

    expect(result.checks).toHaveLength(1);
    expect(result.checks[0]).toMatchObject({
      id: "protocol-invalid-method-error",
      category: "protocol",
      status: "passed",
    });
    expect(result.categorySummary.protocol.passed).toBe(1);
    expect(result.categorySummary.core.total).toBe(0);
  });

  it("does not count truncated SSE frames as complete events", async () => {
    const fetchFn = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body ?? "{}")) as { method?: string };

      if (body.method === "initialize") {
        return jsonResponse(
          { jsonrpc: "2.0", id: 1, result: {} },
          {
            headers: {
              "mcp-session-id": "session-1",
            },
          },
        );
      }

      return sseResponse(["data: partial\n"]);
    }) as typeof fetch;

    const results = await runTransportChecks(
      createTransportContext(fetchFn) as any,
      new Set(["server-sse-streams-functional"]),
    );

    expect(results).toHaveLength(1);
    expect(results[0]).toMatchObject({
      id: "server-sse-streams-functional",
      status: "failed",
    });
    expect(results[0].details).toEqual(
      expect.objectContaining({
        eventCounts: [0, 0, 0],
      }),
    );
  });

  it("returns structured transport failures instead of throwing on stream errors", async () => {
    let postCount = 0;
    const fetchFn = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body ?? "{}")) as { method?: string };

      if (body.method === "initialize") {
        return jsonResponse(
          { jsonrpc: "2.0", id: 1, result: {} },
          {
            headers: {
              "mcp-session-id": "session-1",
            },
          },
        );
      }

      postCount += 1;
      if (postCount === 1) {
        throw new Error("request boom");
      }
      if (postCount === 2) {
        return sseResponse(["data: ok\n\n"]);
      }

      return sseResponse([new Error("stream boom")]);
    }) as typeof fetch;

    const results = await runTransportChecks(
      createTransportContext(fetchFn) as any,
      new Set([
        "server-accepts-multiple-post-streams",
        "server-sse-streams-functional",
      ]),
    );
    const byId = Object.fromEntries(results.map((result) => [result.id, result]));

    expect(byId["server-accepts-multiple-post-streams"]).toMatchObject({
      status: "failed",
      details: expect.objectContaining({
        requestErrors: ["request boom", undefined, undefined],
      }),
    });
    expect(byId["server-sse-streams-functional"]).toMatchObject({
      status: "failed",
      details: expect.objectContaining({
        eventCounts: [1, 0],
        readErrors: [undefined, "stream boom"],
      }),
    });
  });
});
