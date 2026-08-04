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

  it("passes the transport MUSTs for a server that speaks the 2025 wire correctly", async () => {
    const fetchFn = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      if (init?.method === "GET") {
        return sseResponse(["data: hello\n\n"]);
      }
      if (init?.method === "DELETE") {
        return new Response(null, { status: 200 });
      }
      const body = JSON.parse(String(init?.body ?? "{}")) as { method?: string };
      if (body.method === "initialize") {
        return jsonResponse(
          { jsonrpc: "2.0", id: 1, result: {} },
          { headers: { "mcp-session-id": "session-ok-1" } },
        );
      }
      if (body.method === "notifications/initialized") {
        return new Response(null, { status: 202 });
      }
      return jsonResponse({ jsonrpc: "2.0", id: 99, result: {} });
    }) as typeof fetch;

    const results = await runTransportChecks(
      createTransportContext(fetchFn) as any,
      new Set([
        "notification-post-accepted",
        "get-stream-or-405",
        "session-id-visible-ascii",
        "post-response-content-type",
      ]),
    );
    const byId = Object.fromEntries(results.map((result) => [result.id, result]));

    expect(byId["notification-post-accepted"].status).toBe("passed");
    expect(byId["get-stream-or-405"].status).toBe("passed");
    expect(byId["session-id-visible-ascii"].status).toBe("passed");
    expect(byId["post-response-content-type"].status).toBe("passed");
  });

  it("fails the transport MUSTs a mis-framed server violates", async () => {
    const fetchFn = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      if (init?.method === "GET") {
        // Neither an SSE stream nor a 405: an HTML landing page.
        return new Response("<html>hi</html>", {
          status: 200,
          headers: { "content-type": "text/html" },
        });
      }
      if (init?.method === "DELETE") {
        return new Response(null, { status: 405 });
      }
      const body = JSON.parse(String(init?.body ?? "{}")) as { method?: string };
      if (body.method === "initialize") {
        return jsonResponse(
          { jsonrpc: "2.0", id: 1, result: {} },
          // 0x20 (space) sits outside the visible-ASCII MUST.
          { headers: { "mcp-session-id": "bad session id" } },
        );
      }
      if (body.method === "notifications/initialized") {
        // Accepted, but as a 200 with a body instead of a bare 202.
        return jsonResponse({ ok: true }, { status: 200 });
      }
      return jsonResponse({ jsonrpc: "2.0", id: 99, result: {} });
    }) as typeof fetch;

    const results = await runTransportChecks(
      createTransportContext(fetchFn) as any,
      new Set([
        "notification-post-accepted",
        "get-stream-or-405",
        "session-id-visible-ascii",
      ]),
    );
    const byId = Object.fromEntries(results.map((result) => [result.id, result]));

    expect(byId["notification-post-accepted"]).toMatchObject({
      status: "failed",
      error: { message: expect.stringContaining("202 Accepted") },
    });
    expect(byId["get-stream-or-405"]).toMatchObject({
      status: "failed",
      error: { message: expect.stringContaining("405") },
    });
    expect(byId["session-id-visible-ascii"]).toMatchObject({
      status: "failed",
      details: expect.objectContaining({ invalidCharacters: ["U+0020"] }),
    });
  });

  it("judges the initialize response's content-type and rejects text/html", async () => {
    const fetchFn = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      if (init?.method === "DELETE") {
        return new Response(null, { status: 405 });
      }
      return new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, result: {} }), {
        status: 200,
        headers: { "content-type": "text/html", "mcp-session-id": "s-1" },
      });
    }) as typeof fetch;

    const results = await runTransportChecks(
      createTransportContext(fetchFn) as any,
      new Set(["post-response-content-type"]),
    );

    expect(results).toHaveLength(1);
    expect(results[0]).toMatchObject({
      id: "post-response-content-type",
      status: "failed",
      details: expect.objectContaining({ contentType: "text/html" }),
    });
  });

  it("marks the session-id charset check not-applicable for a stateless legacy server", async () => {
    const fetchFn = vi.fn(async () =>
      jsonResponse({ jsonrpc: "2.0", id: 1, result: {} }),
    ) as typeof fetch;

    const results = await runTransportChecks(
      createTransportContext(fetchFn) as any,
      new Set(["session-id-visible-ascii"]),
    );

    expect(results).toHaveLength(1);
    expect(results[0]).toMatchObject({
      id: "session-id-visible-ascii",
      status: "skipped",
      skipReason: "not-applicable",
    });
  });

  it("reports could-not-run for the transport MUSTs when initialize itself fails", async () => {
    const fetchFn = vi.fn(async () =>
      jsonResponse(
        { jsonrpc: "2.0", id: 1, error: { code: -32000, message: "nope" } },
        { status: 500 },
      ),
    ) as typeof fetch;

    const results = await runTransportChecks(
      createTransportContext(fetchFn) as any,
      new Set([
        "notification-post-accepted",
        "get-stream-or-405",
        "session-id-visible-ascii",
        "post-response-content-type",
      ]),
    );
    const byId = Object.fromEntries(results.map((result) => [result.id, result]));

    expect(results).toHaveLength(4);
    for (const id of [
      "notification-post-accepted",
      "get-stream-or-405",
      "session-id-visible-ascii",
    ] as const) {
      expect(byId[id].status).toBe("skipped");
      expect(byId[id].skipReason).toBe("could-not-run");
    }
    // The framing MUST still binds here: the server answered at the MCP layer
    // with a JSON-RPC error, and it framed that answer as application/json.
    expect(byId["post-response-content-type"].status).toBe("passed");
  });

  it("does not accept a content type that merely contains the SSE token", async () => {
    // `text/event-streamish` contains the required token without being it, so
    // a substring test would read this as a conforming stream.
    const fetchFn = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      if (init?.method === "GET") {
        return new Response("", {
          status: 200,
          headers: { "content-type": "text/event-streamish" },
        });
      }
      if (init?.method === "DELETE") {
        return new Response(null, { status: 405 });
      }
      return jsonResponse(
        { jsonrpc: "2.0", id: 1, result: {} },
        { headers: { "mcp-session-id": "s-1" } },
      );
    }) as typeof fetch;

    const results = await runTransportChecks(
      createTransportContext(fetchFn) as any,
      new Set(["get-stream-or-405"]),
    );

    expect(results[0]).toMatchObject({
      id: "get-stream-or-405",
      status: "failed",
    });
  });

  it("accepts an SSE content type that carries parameters", async () => {
    const fetchFn = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      if (init?.method === "GET") {
        return new Response("", {
          status: 200,
          headers: { "content-type": "text/event-stream; charset=utf-8" },
        });
      }
      if (init?.method === "DELETE") {
        return new Response(null, { status: 405 });
      }
      return jsonResponse(
        { jsonrpc: "2.0", id: 1, result: {} },
        { headers: { "mcp-session-id": "s-1" } },
      );
    }) as typeof fetch;

    const results = await runTransportChecks(
      createTransportContext(fetchFn) as any,
      new Set(["get-stream-or-405"]),
    );

    expect(results[0].status).toBe("passed");
  });

  it("judges an MCP-layer error response's framing but not a gateway's", async () => {
    // A non-2xx carrying a JSON-RPC error IS the server answering, so a
    // mis-framed one is a violation...
    const misframedError = vi.fn(async () =>
      new Response(
        JSON.stringify({ jsonrpc: "2.0", id: 1, error: { code: -32000, message: "no" } }),
        { status: 400, headers: { "content-type": "text/html" } },
      ),
    ) as typeof fetch;

    const failed = await runTransportChecks(
      createTransportContext(misframedError) as any,
      new Set(["post-response-content-type"]),
    );
    expect(failed[0]).toMatchObject({
      status: "failed",
      details: expect.objectContaining({ contentType: "text/html" }),
    });

    // ...while a non-2xx with no JSON-RPC body never reached the MCP server —
    // an auth gateway or proxy produced it — so the run establishes nothing
    // rather than blaming the server for someone else's framing.
    const gateway = vi.fn(async () =>
      new Response("<html>401</html>", {
        status: 401,
        headers: { "content-type": "text/html" },
      }),
    ) as typeof fetch;

    const skipped = await runTransportChecks(
      createTransportContext(gateway) as any,
      new Set(["post-response-content-type"]),
    );
    expect(skipped[0]).toMatchObject({
      status: "skipped",
      skipReason: "could-not-run",
    });
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
