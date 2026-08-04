/**
 * Phase 7 §15.4 — the readiness / interoperability channel.
 *
 * The contract under test is a separation, not a verdict: non-MUST advice
 * (SHOULD / RECOMMENDED / MAY) is reported as a warning and NEVER becomes a
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

  it("stays silent when the order is stable and metadata is complete", async () => {
    mockedOperations.listTools.mockResolvedValue({
      tools: [tool("alpha"), tool("beta")],
      nextCursor: undefined,
    } as never);

    const warnings = await collectClientReadiness(clientContext(), surface());
    expect(warnings).toEqual([]);
  });

  it("warns about incomplete primitive metadata", async () => {
    mockedOperations.listTools.mockResolvedValue({
      tools: [tool("alpha")],
      nextCursor: undefined,
    } as never);

    const warnings = await collectClientReadiness(
      clientContext(),
      surface({
        tools: [tool("alpha", { description: "", title: undefined })],
      })
    );
    const metadata = warnings.find(
      (item) => item.id === "readiness-metadata-quality"
    );

    expect(metadata?.specStrength).toBe("SHOULD");
    expect(metadata?.details).toMatchObject({
      missingDescription: ["alpha"],
      missingTitle: ["alpha"],
    });
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

    expect(deprecated?.specStrength).toBe("SHOULD");
    expect(deprecated?.message).toMatch(/logging\/setLevel/);
    expect(deprecated?.message).toMatch(/subscriptions\/listen/);
  });
});

describe("raw readiness advice", () => {
  it("warns that a zero cache TTL is useless, and never fails", async () => {
    const fetchFn = (async (input: RequestInfo | URL) => {
      if (String(input).includes(".well-known")) {
        return new Response("{}", { status: 404 });
      }
      return new Response(
        JSON.stringify({
          jsonrpc: "2.0",
          id: 8100,
          result: { tools: [], resultType: "complete", ttlMs: 0 },
        }),
        { status: 200, headers: { "content-type": "application/json" } }
      );
    }) as unknown as typeof fetch;

    const warnings = await collectRawReadiness(
      rawContext(fetchFn, "2026-07-28")
    );
    const ttl = warnings.find(
      (item) => item.id === "readiness-cache-ttl-useful"
    );

    expect(ttl?.severity).toBe("warning");
    expect(ttl?.specStrength).toBe("SHOULD");
    expect(ttl?.details).toMatchObject({ method: "tools/list", ttlMs: 0 });
  });

  it("recommends emitting iss when the authorization server does not advertise it", async () => {
    const fetchFn = (async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.endsWith("/.well-known/oauth-protected-resource")) {
        return new Response(
          JSON.stringify({ authorization_servers: ["https://as.example.com"] }),
          { status: 200, headers: { "content-type": "application/json" } }
        );
      }
      if (url.endsWith("/.well-known/oauth-authorization-server")) {
        return new Response(
          JSON.stringify({ issuer: "https://as.example.com" }),
          { status: 200, headers: { "content-type": "application/json" } }
        );
      }
      return new Response("{}", { status: 404 });
    }) as unknown as typeof fetch;

    const warnings = await collectRawReadiness(rawContext(fetchFn));
    const iss = warnings.find(
      (item) => item.id === "readiness-oauth-iss-advertised"
    );

    expect(iss?.specStrength).toBe("RECOMMENDED");
    expect(iss?.details).toMatchObject({ issuer: "https://as.example.com" });
  });

  it("stays silent when iss is advertised", async () => {
    const fetchFn = (async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.endsWith("/.well-known/oauth-protected-resource")) {
        return new Response(
          JSON.stringify({ authorization_servers: ["https://as.example.com"] }),
          { status: 200, headers: { "content-type": "application/json" } }
        );
      }
      if (url.endsWith("/.well-known/oauth-authorization-server")) {
        return new Response(
          JSON.stringify({
            issuer: "https://as.example.com",
            authorization_response_iss_parameter_supported: true,
          }),
          { status: 200, headers: { "content-type": "application/json" } }
        );
      }
      return new Response("{}", { status: 404 });
    }) as unknown as typeof fetch;

    expect(await collectRawReadiness(rawContext(fetchFn))).toEqual([]);
  });

  it("advises when unparseable JSON is accepted as success, and stays silent on any rejection", async () => {
    const accepting = (async () =>
      new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, result: {} }), {
        status: 200,
        headers: { "content-type": "application/json" },
      })) as unknown as typeof fetch;

    const warnings = await collectRawReadiness(rawContext(accepting));
    const parse = warnings.find(
      (item) => item.id === "readiness-parse-error-handling"
    );
    expect(parse?.specStrength).toBe("MAY");
    expect(parse?.message).toMatch(/-32700/);

    const rejecting = (async () =>
      new Response("Bad Request", { status: 400 })) as unknown as typeof fetch;
    const silent = await collectRawReadiness(rawContext(rejecting));
    expect(
      silent.find((item) => item.id === "readiness-parse-error-handling")
    ).toBeUndefined();
  });

  it("advises when the legacy session-termination DELETE answers 5xx, and accepts a 405 decline", async () => {
    const brokenDelete = (async (_input: RequestInfo | URL, init?: RequestInit) => {
      if (init?.method === "DELETE") {
        return new Response("boom", { status: 500 });
      }
      const body = String(init?.body ?? "");
      if (body.includes("initialize")) {
        return new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, result: {} }), {
          status: 200,
          headers: {
            "content-type": "application/json",
            "mcp-session-id": "session-1",
          },
        });
      }
      return new Response("Bad Request", { status: 400 });
    }) as unknown as typeof fetch;

    const warnings = await collectRawReadiness(rawContext(brokenDelete));
    const termination = warnings.find(
      (item) => item.id === "readiness-session-termination"
    );
    expect(termination?.specStrength).toBe("SHOULD");
    expect(termination?.details).toMatchObject({ status: 500 });

    const declining = (async (_input: RequestInfo | URL, init?: RequestInit) => {
      if (init?.method === "DELETE") {
        return new Response(null, { status: 405 });
      }
      const body = String(init?.body ?? "");
      if (body.includes("initialize")) {
        return new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, result: {} }), {
          status: 200,
          headers: {
            "content-type": "application/json",
            "mcp-session-id": "session-1",
          },
        });
      }
      return new Response("Bad Request", { status: 400 });
    }) as unknown as typeof fetch;

    const silent = await collectRawReadiness(rawContext(declining));
    expect(
      silent.find((item) => item.id === "readiness-session-termination")
    ).toBeUndefined();
  });

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
        JSON.stringify({ jsonrpc: "2.0", id: 8100, result: { tools: [], resultType: "complete" } }),
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
