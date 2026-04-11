import { MCPConformanceTest } from "../../src/mcp-conformance/index.js";
import { runTransportChecks } from "../../src/mcp-conformance/checks/transport.js";
import { TOOL_CHECKS } from "../../src/mcp-conformance/checks/tools.js";
import * as operations from "../../src/operations.js";

jest.mock("../../src/operations.js", () => ({
  listPrompts: jest.fn(),
  listResources: jest.fn(),
  listTools: jest.fn(),
  withEphemeralClient: jest.fn(),
}));

const mockedOperations = jest.mocked(operations);

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
    },
    serverUrl: "https://example.com/mcp",
    fetchFn,
  };
}

describe("mcp conformance unit checks", () => {
  afterEach(() => {
    jest.resetAllMocks();
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
        listTools: jest.fn().mockResolvedValue({
          tools: [{ name: "echo", inputSchema: {} }],
        }),
      } as any,
      serverId: "server-1",
    } as any);

    expect(result.status).toBe("passed");
  });

  it("does not abort core-only runs when optional list methods fail during setup", async () => {
    mockedOperations.withEphemeralClient.mockImplementation(
      async (_config, fn) =>
        fn(
          {
            getClient: jest.fn().mockReturnValue({}),
            getInitializationInfo: jest.fn().mockReturnValue({
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
    const fetchFn = jest.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
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
    const fetchFn = jest.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
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
    const fetchFn = jest.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
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
