/**
 * Phase 7 §15.4 — the readiness / interoperability channel.
 *
 * The contract under test is a separation, not a verdict: non-MUST advice
 * (SHOULD / MAY) is reported as a warning and NEVER becomes a
 * check result, so it cannot move `passed`, a check status, or the category
 * summary. These tests drive the collectors directly so each advice item can
 * be provoked without needing a server that misbehaves in that exact way.
 */

import type { Tool } from "@modelcontextprotocol/client";
import {
  collectClientReadiness,
  collectRawReadiness,
} from "../../src/mcp-conformance/readiness.js";
import type {
  MCPClientCheckContext,
  MCPServerSurfaceSnapshot,
  NormalizedMCPConformanceConfig,
  RawHttpCheckContext,
} from "../../src/mcp-conformance/types.js";
import { normalizeMCPConformanceConfig } from "../../src/mcp-conformance/validation.js";
import * as operations from "../../src/operations.js";

vi.mock("../../src/operations.js", () => ({
  listPrompts: vi.fn(),
  listResources: vi.fn(),
  listTools: vi.fn(),
  withEphemeralClient: vi.fn(),
}));

const mockedOperations = vi.mocked(operations);

const SERVER_URL = "https://example.com/mcp";

function tool(name: string, extra: Partial<Tool> = {}): Tool {
  return {
    name,
    description: `describes ${name}`,
    title: `Title ${name}`,
    inputSchema: { type: "object" as const },
    ...extra,
  } as Tool;
}

function surface(
  overrides: Partial<MCPServerSurfaceSnapshot> = {}
): MCPServerSurfaceSnapshot {
  const tools = overrides.tools ?? [tool("alpha"), tool("beta")];
  return {
    tools,
    toolNames: tools.map((entry) => entry.name),
    promptNames: [],
    resourceUris: [],
    resourceTemplateUris: [],
    serverCapabilities: {},
    ...overrides,
  };
}

function clientContext(
  overrides: {
    era?: "legacy" | "modern";
    protocolVersion?: NormalizedMCPConformanceConfig["protocolVersion"];
    serverName?: string;
    serverCapabilities?: Record<string, unknown>;
  } = {}
): MCPClientCheckContext {
  const config = normalizeMCPConformanceConfig({
    serverUrl: SERVER_URL,
    protocolVersion: overrides.protocolVersion,
  });
  return {
    manager: {} as MCPClientCheckContext["manager"],
    client: {} as MCPClientCheckContext["client"],
    serverId: "server-1",
    config,
    initializationInfo: {
      protocolVersion: overrides.protocolVersion ?? "2025-11-25",
      transport: "streamable-http",
      serverCapabilities: overrides.serverCapabilities ?? {},
      serverVersion: { name: overrides.serverName ?? "fixture", version: "1" },
    } as MCPClientCheckContext["initializationInfo"],
    availableTools: [],
    availablePrompts: [],
    availableResources: [],
    availableResourceTemplates: [],
  };
}

function rawContext(
  fetchFn: typeof fetch,
  protocolVersion?: "2026-07-28"
): RawHttpCheckContext {
  const config = normalizeMCPConformanceConfig({
    serverUrl: SERVER_URL,
    fetchFn,
    protocolVersion,
    checkTimeout: 500,
  });
  return { config, serverUrl: SERVER_URL, fetchFn: config.fetchFn };
}

afterEach(() => {
  vi.resetAllMocks();
});

describe("client readiness advice", () => {
  it("warns when tools/list is not deterministically ordered", async () => {
    mockedOperations.listTools.mockResolvedValue({
      tools: [tool("beta"), tool("alpha")],
      nextCursor: undefined,
    } as never);

    const warnings = await collectClientReadiness(clientContext(), surface());
    const order = warnings.find(
      (item) => item.id === "readiness-tool-order-deterministic"
    );

    expect(order).toBeDefined();
    expect(order?.severity).toBe("warning");
    expect(order?.specStrength).toBe("SHOULD");
    expect(order?.details).toMatchObject({
      firstListing: ["alpha", "beta"],
      secondListing: ["beta", "alpha"],
    });
  });

  it("stays silent when the order is stable", async () => {
    mockedOperations.listTools.mockResolvedValue({
      tools: [tool("alpha"), tool("beta")],
      nextCursor: undefined,
    } as never);

    const warnings = await collectClientReadiness(clientContext(), surface());
    expect(warnings).toEqual([]);
  });

  it("warns when a modern server still advertises superseded functionality", async () => {
    mockedOperations.listTools.mockResolvedValue({
      tools: [tool("alpha"), tool("beta")],
      nextCursor: undefined,
    } as never);

    const warnings = await collectClientReadiness(
      clientContext({
        protocolVersion: "2026-07-28",
        serverCapabilities: { logging: {}, resources: { subscribe: true } },
      }),
      surface({
        serverCapabilities: { logging: {}, resources: { subscribe: true } },
      })
    );
    const deprecated = warnings.find(
      (item) => item.id === "readiness-deprecated-feature-use"
    );

    expect(deprecated?.specStrength).toBe("Deprecation Notice");
    expect(deprecated?.message).toMatch(/logging\/setLevel/);
    expect(deprecated?.message).toMatch(/subscriptions\/listen/);
  });

  it("labels a superseded legacy revision as a deprecation notice", async () => {
    const warnings = await collectClientReadiness(
      clientContext({ protocolVersion: "2025-06-18" }),
      surface()
    );
    expect(warnings).toContainEqual(
      expect.objectContaining({
        id: "readiness-deprecated-feature-use",
        specStrength: "Deprecation Notice",
        message: expect.stringContaining("2025-06-18 is superseded"),
      })
    );
  });

  it("advises on tool names that break the naming conventions, without costing points", async () => {
    const longName = "a".repeat(129);
    const tools = [tool(longName), tool("has space"), tool("dup"), tool("dup")];
    mockedOperations.listTools.mockResolvedValue({
      tools,
      nextCursor: undefined,
    } as never);

    const warnings = await collectClientReadiness(
      clientContext(),
      surface({ tools })
    );
    const names = warnings.find(
      (item) => item.id === "readiness-tool-name-conventions"
    );

    expect(names?.specStrength).toBe("SHOULD");
    expect(names?.informational).toBe(true);
    expect(names?.details).toEqual({
      badLength: [longName],
      badCharacters: ["has space"],
      duplicates: ["dup"],
    });
  });

  it("gives no tool-name advice before 2025-11-25, where the rules do not exist", async () => {
    const tools = [tool("has space")];
    mockedOperations.listTools.mockResolvedValue({
      tools,
      nextCursor: undefined,
    } as never);

    const warnings = await collectClientReadiness(
      clientContext({ protocolVersion: "2025-06-18" }),
      surface({ tools })
    );

    expect(
      warnings.find((item) => item.id === "readiness-tool-name-conventions")
    ).toBeUndefined();
  });

  it("counts each bad name once, names it in the message, and skips names that are not strings", async () => {
    const tools = [
      tool("has space"),
      tool("has space"),
      tool(""),
      tool(null as unknown as string),
    ];
    mockedOperations.listTools.mockResolvedValue({
      tools,
      nextCursor: undefined,
    } as never);

    const warnings = await collectClientReadiness(
      clientContext(),
      surface({ tools })
    );
    const names = warnings.find(
      (item) => item.id === "readiness-tool-name-conventions"
    );

    expect(names?.details).toEqual({
      badLength: [""],
      badCharacters: ["has space"],
      duplicates: ["has space"],
    });
    expect(names?.message).toContain('"has space"');
  });

  it("advises on a modern run, with or without a negotiated revision", async () => {
    const tools = [tool("has space")];
    mockedOperations.listTools.mockResolvedValue({
      tools,
      nextCursor: undefined,
    } as never);
    const find = (
      warnings: Awaited<ReturnType<typeof collectClientReadiness>>
    ) => warnings.find((item) => item.id === "readiness-tool-name-conventions");

    const modern = clientContext({ protocolVersion: "2026-07-28" });
    expect(
      find(await collectClientReadiness(modern, surface({ tools })))
    ).toBeDefined();

    const noNegotiation = { ...modern, initializationInfo: undefined };
    expect(
      find(await collectClientReadiness(noNegotiation, surface({ tools })))
    ).toBeDefined();
  });
});

describe("raw readiness advice", () => {
  it("leaves iss advice to the OAuth suite and fetches no OAuth metadata", async () => {
    const urls: string[] = [];
    const fetchFn = (async (input: RequestInfo | URL) => {
      urls.push(String(input));
      return new Response("{}", { status: 404 });
    }) as unknown as typeof fetch;

    const warnings = await collectRawReadiness(rawContext(fetchFn));
    expect(warnings.map((item) => item.id)).not.toContain(
      "readiness-oauth-iss-advertised"
    );
    expect(urls.filter((url) => url.includes("/.well-known/"))).toEqual([]);
  });

  // The spec names two answers to the legacy session-termination DELETE:
  // terminate it (any 2xx) or decline with 405. Anything else earns advice.
  const legacyDeleteAnswering = (status: number) =>
    (async (_input: RequestInfo | URL, init?: RequestInit) => {
      if (init?.method === "DELETE") {
        return new Response(null, { status });
      }
      const body = String(init?.body ?? "");
      if (body.includes("initialize")) {
        return new Response(
          JSON.stringify({ jsonrpc: "2.0", id: 1, result: {} }),
          {
            status: 200,
            headers: {
              "content-type": "application/json",
              "mcp-session-id": "session-1",
            },
          }
        );
      }
      return new Response("Bad Request", { status: 400 });
    }) as unknown as typeof fetch;

  it.each([400, 404, 500])(
    "advises when the legacy session-termination DELETE answers %i",
    async (status) => {
      const warnings = await collectRawReadiness(
        rawContext(legacyDeleteAnswering(status))
      );
      const termination = warnings.find(
        (item) => item.id === "readiness-session-termination"
      );
      expect(termination?.specStrength).toBe("SHOULD");
      expect(termination?.details).toMatchObject({ status });
    }
  );

  it.each([200, 204, 405])(
    "accepts a legacy session-termination DELETE answered %i",
    async (status) => {
      const silent = await collectRawReadiness(
        rawContext(legacyDeleteAnswering(status))
      );
      expect(
        silent.find((item) => item.id === "readiness-session-termination")
      ).toBeUndefined();
    }
  );

  it("advises a modern server whose DELETE is not answered 405, probing as an older client would", async () => {
    const deleteHeaders: Array<Record<string, string>> = [];
    const fetchFn = (async (_input: RequestInfo | URL, init?: RequestInit) => {
      if (String(_input).includes(".well-known")) {
        return new Response("{}", { status: 404 });
      }
      if (init?.method === "DELETE") {
        const seen: Record<string, string> = {};
        new Headers(init.headers).forEach((value, key) => {
          seen[key.toLowerCase()] = value;
        });
        deleteHeaders.push(seen);
        return new Response(null, { status: 200 });
      }
      return new Response(
        JSON.stringify({
          jsonrpc: "2.0",
          id: 8100,
          result: { tools: [], resultType: "complete" },
        }),
        { status: 200, headers: { "content-type": "application/json" } }
      );
    }) as unknown as typeof fetch;

    const warnings = await collectRawReadiness(
      rawContext(fetchFn, "2026-07-28")
    );
    const termination = warnings.find(
      (item) => item.id === "readiness-session-termination"
    );
    expect(termination?.specStrength).toBe("SHOULD");
    expect(termination?.message).toMatch(/405/);
    // The obligation covers traffic from an OLDER client, so the probe carries
    // a 2025 pin and a session id rather than a bare DELETE a header-validating
    // server could reject for the missing version.
    expect(deleteHeaders).toHaveLength(1);
    expect(deleteHeaders[0]["mcp-protocol-version"]).toBe("2025-11-25");
    expect(deleteHeaders[0]["mcp-session-id"]).toBeTruthy();
  });

  it("keeps the DELETE finding when the GET probe never completes", async () => {
    const fetchFn = (async (input: RequestInfo | URL, init?: RequestInit) => {
      if (String(input).includes(".well-known")) {
        return new Response("{}", { status: 404 });
      }
      if (init?.method === "GET") {
        throw new Error("GET timed out");
      }
      if (init?.method === "DELETE") {
        return new Response(null, { status: 200 });
      }
      return new Response(
        JSON.stringify({
          jsonrpc: "2.0",
          id: 8100,
          result: { tools: [], resultType: "complete" },
        }),
        { status: 200, headers: { "content-type": "application/json" } }
      );
    }) as unknown as typeof fetch;

    const warnings = await collectRawReadiness(
      rawContext(fetchFn, "2026-07-28")
    );
    const termination = warnings.find(
      (item) => item.id === "readiness-session-termination"
    );

    // One probe failing must not bury what the other observed.
    expect(termination?.message).toMatch(/DELETE got HTTP 200/);
    expect(termination?.message).not.toMatch(/GET got HTTP/);
    expect(termination?.details).toMatchObject({ getStatus: "not observed" });
  });

  it("swallows a probe that throws — advice never disturbs a run", async () => {
    const fetchFn = (async () => {
      throw new Error("network down");
    }) as unknown as typeof fetch;

    expect(
      await collectRawReadiness(rawContext(fetchFn, "2026-07-28"))
    ).toEqual([]);
  });
});

describe("log level filtering advice", () => {
  function logContext(
    fetchFn: typeof fetch,
    logProbe?: NormalizedMCPConformanceConfig["logProbe"],
    era: "legacy" | "modern" = "modern",
    logLevelFilteringProbe?: NormalizedMCPConformanceConfig["logLevelFilteringProbe"]
  ): RawHttpCheckContext {
    const config = normalizeMCPConformanceConfig({
      serverUrl: SERVER_URL,
      fetchFn,
      protocolVersion: era === "modern" ? "2026-07-28" : undefined,
      checkTimeout: 500,
      logProbe,
      ...(logLevelFilteringProbe ? { logLevelFilteringProbe } : {}),
    });
    return { config, serverUrl: SERVER_URL, fetchFn: config.fetchFn };
  }

  /** Answers every request; a `tools/call` streams `levels` first. */
  function logServer(
    levels: unknown[],
    result: Record<string, unknown> = { resultType: "complete", content: [] }
  ) {
    const toolCalls: Array<Record<string, unknown>> = [];
    const fetchFn = (async (_input: RequestInfo | URL, init?: RequestInit) => {
      const body = init?.body ? JSON.parse(String(init.body)) : {};
      if (body.method !== "tools/call") {
        return new Response("{}", { status: 404 });
      }
      toolCalls.push(body);
      const messages = [
        ...levels.map((level) => ({
          jsonrpc: "2.0",
          method: "notifications/message",
          params: { level, data: "log" },
        })),
        { jsonrpc: "2.0", id: body.id, result },
      ];
      return new Response(
        messages
          .map(
            (message) => `event: message\ndata: ${JSON.stringify(message)}\n\n`
          )
          .join(""),
        { headers: { "Content-Type": "text/event-stream" } }
      );
    }) as unknown as typeof fetch;
    return { fetchFn, toolCalls };
  }

  async function advice(context: RawHttpCheckContext) {
    const warnings = await collectRawReadiness(context);
    return warnings.find((item) => item.id === "readiness-log-level-filtering");
  }

  it("calls no tool and gives no advice without a logProbe", async () => {
    const server = logServer(["debug"]);
    expect(await advice(logContext(server.fetchFn))).toBeUndefined();
    expect(server.toolCalls).toEqual([]);
  });

  it("gives no advice on a legacy run", async () => {
    const server = logServer([]);
    expect(
      await advice(
        logContext(server.fetchFn, { toolName: "emit-log" }, "legacy")
      )
    ).toBeUndefined();
    expect(server.toolCalls).toEqual([]);
  });

  it("asks for warning by default and flags an unknown level", async () => {
    const server = logServer(["warning", "bogus"]);
    const found = await advice(
      logContext(server.fetchFn, {
        toolName: "emit-log",
        arguments: { count: 2 },
      })
    );
    expect(found).toMatchObject({
      specStrength: "MAY",
      informational: true,
      details: {
        probedTool: "emit-log",
        requestedLogLevel: "warning",
        invalidOrLowerLevels: ["bogus"],
      },
    });
    expect(server.toolCalls[0]?.params).toMatchObject({
      name: "emit-log",
      arguments: { count: 2 },
      _meta: { "io.modelcontextprotocol/logLevel": "warning" },
    });
  });

  it("flags no logs at the picked level", async () => {
    const server = logServer([]);
    const found = await advice(
      logContext(server.fetchFn, { toolName: "emit-log", level: "error" })
    );
    expect(found?.message).toMatch(/^No logs came back/);
    expect(found?.details).toMatchObject({
      requestedLogLevel: "error",
      logNotificationCount: 0,
    });
  });

  it("gives no advice when every log is at or above the level", async () => {
    const server = logServer(["error", "critical"]);
    expect(
      await advice(
        logContext(server.fetchFn, { toolName: "emit-log", level: "error" })
      )
    ).toBeUndefined();
  });

  for (const [label, result] of [
    ["a tool error", { resultType: "complete", content: [], isError: true }],
    ["an unfinished call", { resultType: "input_required", inputRequests: [] }],
  ] as const) {
    it(`gives no advice for ${label}`, async () => {
      const server = logServer([], result);
      expect(
        await advice(logContext(server.fetchFn, { toolName: "emit-log" }))
      ).toBeUndefined();
    });
  }

  it("rejects an unknown logProbe level", () => {
    expect(() =>
      normalizeMCPConformanceConfig({
        serverUrl: SERVER_URL,
        logProbe: {
          toolName: "emit-log",
          level: "loud" as NonNullable<
            NormalizedMCPConformanceConfig["logProbe"]
          >["level"],
        },
      })
    ).toThrow(/logProbe.level must be one of debug, info/);
  });

  it("calls its own tool, arguments and level when one is set", async () => {
    const server = logServer(["error"]);
    await advice(
      logContext(
        server.fetchFn,
        { toolName: "emit-log", arguments: { count: 2 }, level: "debug" },
        "modern",
        { toolName: "other-log", arguments: { loud: true }, level: "error" }
      )
    );
    expect(server.toolCalls).toHaveLength(1);
    expect(server.toolCalls[0]?.params).toMatchObject({
      name: "other-log",
      arguments: { loud: true },
      _meta: { "io.modelcontextprotocol/logLevel": "error" },
    });
  });

  it("runs on its own tool without a logProbe", async () => {
    const server = logServer([]);
    const found = await advice(
      logContext(server.fetchFn, undefined, "modern", {
        toolName: "other-log",
      })
    );
    expect(found?.details).toMatchObject({
      probedTool: "other-log",
      requestedLogLevel: "warning",
    });
  });

  it("rejects an unknown level on its own tool", () => {
    expect(() =>
      normalizeMCPConformanceConfig({
        serverUrl: SERVER_URL,
        logLevelFilteringProbe: {
          toolName: "other-log",
          level: "loud" as NonNullable<
            NormalizedMCPConformanceConfig["logProbe"]
          >["level"],
        },
      })
    ).toThrow(/logLevelFilteringProbe.level must be one of debug, info/);
  });
});

describe("picking advice with readinessIds", () => {
  function countingFetch() {
    const seen = { requests: 0 };
    const fetchFn = (async () => {
      seen.requests += 1;
      return new Response("{}", { status: 200 });
    }) as unknown as typeof fetch;
    return { fetchFn, seen };
  }

  function pickedContext(
    fetchFn: typeof fetch,
    readinessIds: NormalizedMCPConformanceConfig["readinessIds"]
  ): RawHttpCheckContext {
    const config = normalizeMCPConformanceConfig({
      serverUrl: SERVER_URL,
      fetchFn,
      protocolVersion: "2026-07-28",
      checkTimeout: 500,
      logProbe: { toolName: "emit-log" },
      readinessIds,
    });
    return { config, serverUrl: SERVER_URL, fetchFn: config.fetchFn };
  }

  it("sends no probe at all when the list is empty", async () => {
    const server = countingFetch();
    expect(
      await collectRawReadiness(pickedContext(server.fetchFn, []))
    ).toEqual([]);
    expect(server.seen.requests).toBe(0);
  });

  it("sends only the picked advice's probe", async () => {
    const server = countingFetch();
    const warnings = await collectRawReadiness(
      pickedContext(server.fetchFn, [
        "readiness-protocol-version-header-required",
      ])
    );
    expect(warnings.map((item) => item.id)).toEqual([
      "readiness-protocol-version-header-required",
    ]);
    expect(server.seen.requests).toBe(1);
  });

  it("skips client advice left out, including the repeat tools/list", async () => {
    const context = clientContext({
      protocolVersion: "2026-07-28",
      serverCapabilities: { logging: {} },
    });
    const warnings = await collectClientReadiness(
      {
        ...context,
        config: {
          ...context.config,
          readinessIds: ["readiness-deprecated-feature-use"],
        },
      },
      surface({
        tools: [tool("bad name")],
        serverCapabilities: { logging: {} },
      })
    );
    expect(warnings.map((item) => item.id)).toEqual([
      "readiness-deprecated-feature-use",
    ]);
    expect(mockedOperations.listTools).not.toHaveBeenCalled();
  });

  it("keeps an empty list and rejects an unknown id", () => {
    expect(
      normalizeMCPConformanceConfig({ serverUrl: SERVER_URL, readinessIds: [] })
        .readinessIds
    ).toEqual([]);
    expect(
      normalizeMCPConformanceConfig({ serverUrl: SERVER_URL }).readinessIds
    ).toBeUndefined();
    expect(() =>
      normalizeMCPConformanceConfig({
        serverUrl: SERVER_URL,
        readinessIds: [
          "readiness-made-up" as NonNullable<
            NormalizedMCPConformanceConfig["readinessIds"]
          >[number],
        ],
      })
    ).toThrow(/Unknown MCP conformance readiness id: readiness-made-up/);
  });
});
