/**
 * Unit coverage for conformance era-awareness (Phase 3 §11.5).
 *
 * These tests deliberately import from `types.js` / `validation.js` and the
 * individual raw-check runners rather than the package `index.js`, so they
 * do NOT pull in the MCP client/server packages — they run without a live
 * server and without the beta.4 dual-era fixture. The end-to-end fixture
 * assertions live in `era.integration.test.ts`.
 */

import {
  CHECK_ERAS,
  MCP_CHECK_IDS,
  MCP_PROTOCOL_VERSION_ERA_IDS,
  PROTOCOL_VERSION_ERAS,
  type MCPCheckId,
  type NormalizedMCPConformanceConfig,
} from "../../src/mcp-conformance/types.js";
import { MCP_PROTOCOL_VERSIONS } from "../../src/mcp-client-manager/mcp-protocol-version.js";
import { normalizeMCPConformanceConfig } from "../../src/mcp-conformance/validation.js";
import { runModernChecks } from "../../src/mcp-conformance/checks/modern.js";
import { runProtocolChecks } from "../../src/mcp-conformance/checks/protocol.js";
import { runSecurityChecks } from "../../src/mcp-conformance/checks/security.js";
import { runTransportChecks } from "../../src/mcp-conformance/checks/transport.js";

const SERVER_URL = "http://127.0.0.1:9/mcp";

function jsonRpcErrorResponse(): Response {
  return new Response(
    JSON.stringify({
      jsonrpc: "2.0",
      id: 99,
      error: { code: -32601, message: "Method not found" },
    }),
    { status: 200, headers: { "content-type": "application/json" } }
  );
}

function initializeResponse(sessionId?: string): Response {
  return new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, result: {} }), {
    status: 200,
    headers: {
      "content-type": "application/json",
      ...(sessionId ? { "mcp-session-id": sessionId } : {}),
    },
  });
}

function normalize(
  overrides: Partial<Parameters<typeof normalizeMCPConformanceConfig>[0]> = {}
): NormalizedMCPConformanceConfig {
  return normalizeMCPConformanceConfig({
    serverUrl: SERVER_URL,
    ...overrides,
  });
}

describe("normalizeMCPConformanceConfig — protocolVersion → era", () => {
  it("defaults to the legacy era with no protocolVersion", () => {
    const config = normalize();
    expect(config.era).toBe("legacy");
    expect(config.protocolVersion).toBeUndefined();
  });

  it("classifies a stateful pin as legacy", () => {
    const config = normalize({ protocolVersion: "2025-11-25" });
    expect(config.era).toBe("legacy");
    expect(config.protocolVersion).toBe("2025-11-25");
  });

  it("classifies the 2026 pin as modern", () => {
    const config = normalize({ protocolVersion: "2026-07-28" });
    expect(config.era).toBe("modern");
    expect(config.protocolVersion).toBe("2026-07-28");
  });

  it("throws on an unknown protocolVersion (mirrors category/checkId errors)", () => {
    expect(() =>
      normalize({ protocolVersion: "DRAFT-2027-zzz" as never })
    ).toThrow(/Unknown MCP conformance protocolVersion/);
  });
});

describe("CHECK_ERAS map", () => {
  it("is exhaustive over MCP_CHECK_IDS with no extra keys", () => {
    const eraKeys = Object.keys(CHECK_ERAS).sort();
    const ids = [...MCP_CHECK_IDS].sort();
    expect(eraKeys).toEqual(ids);
  });

  it("assigns every check a non-empty era list (no check is dead in both eras)", () => {
    for (const id of MCP_CHECK_IDS) {
      expect(CHECK_ERAS[id].length).toBeGreaterThan(0);
      for (const era of CHECK_ERAS[id]) {
        expect(["legacy", "modern"]).toContain(era);
      }
    }
  });

  it("classifies the era-specific and neutral checks as specified", () => {
    const legacyOnly: MCPCheckId[] = [
      "server-initialize",
      "ping",
      "server-sse-polling-session",
      "server-accepts-multiple-post-streams",
      "server-sse-streams-functional",
      "notification-post-accepted",
      "get-stream-or-405",
      "session-id-visible-ascii",
      "localhost-host-rebinding-rejected",
      "localhost-host-valid-accepted",
    ];
    const bothEras: MCPCheckId[] = [
      "capabilities-consistent",
      "post-response-content-type",
      "tools-list",
      "tools-input-schemas-valid",
      "prompts-list",
      "resources-list",
      "logging-set-level",
      "completion-complete",
      "protocol-invalid-method-error",
      // Every revision publishes its own JSON Schema, so the requirement reads
      // the same on either wire and only the document changes.
      "wire-schema-valid",
    ];
    // Modern-only ids are USUALLY prefixed `modern-`; the SEP-2243 declaration
    // check is not, because it belongs to the tools family and reads as one of
    // the `tools-*` checks in a report. Listed explicitly so the coverage
    // assertion below stays exhaustive rather than prefix-shaped.
    const modernOnlyExplicit: MCPCheckId[] = [
      "tools-x-mcp-header-declarations-valid",
    ];
    const modernOnly = [
      ...MCP_CHECK_IDS.filter((id) => id.startsWith("modern-")),
      ...modernOnlyExplicit,
    ];

    for (const id of legacyOnly) {
      expect(CHECK_ERAS[id]).toEqual(["legacy"]);
    }
    for (const id of bothEras) {
      expect([...CHECK_ERAS[id]].sort()).toEqual(["legacy", "modern"]);
    }
    for (const id of modernOnly) {
      expect(CHECK_ERAS[id]).toEqual(["modern"]);
    }
    // Sanity: the three partitions cover every id exactly once.
    expect([...legacyOnly, ...bothEras, ...modernOnly].sort()).toEqual(
      [...MCP_CHECK_IDS].sort()
    );
  });
});

describe("PROTOCOL_VERSION_ERAS map (§15.1 version registry)", () => {
  it("classifies every supported protocol version exactly once", () => {
    expect(Object.keys(PROTOCOL_VERSION_ERAS).sort()).toEqual(
      [...MCP_PROTOCOL_VERSIONS].sort()
    );
    expect(MCP_PROTOCOL_VERSION_ERA_IDS.sort()).toEqual(
      [...MCP_PROTOCOL_VERSIONS].sort()
    );
  });

  it("classifies only the 2026 revision as modern", () => {
    for (const version of MCP_PROTOCOL_VERSIONS) {
      expect(PROTOCOL_VERSION_ERAS[version]).toBe(
        version === "2026-07-28" ? "modern" : "legacy"
      );
    }
  });
});

describe("modern checks on a legacy run", () => {
  it("era-skip before any HTTP is attempted", async () => {
    let fetchCalled = false;
    const fetchFn = (async () => {
      fetchCalled = true;
      return new Response("{}");
    }) as unknown as typeof fetch;

    const config = normalize({ fetchFn });
    const modernIds = MCP_CHECK_IDS.filter(
      (id): id is MCPCheckId =>
        id.startsWith("modern-") && id !== "modern-client-handshake"
    );
    const results = await runModernChecks(
      { config, serverUrl: SERVER_URL, fetchFn: config.fetchFn },
      new Set(modernIds)
    );

    expect(fetchCalled).toBe(false);
    expect(results).toHaveLength(modernIds.length);
    for (const result of results) {
      expect(result.status).toBe("skipped");
      expect(result.error?.message).toMatch(/Not applicable to the legacy era/);
    }
  });

  it("the three subscription checks skip — never fail — when nothing is subscribable", async () => {
    const methods: string[] = [];
    const fetchFn = (async (_url: unknown, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)) as { method: string };
      methods.push(body.method);
      return new Response(
        JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          result: {
            resultType: "discover",
            protocolVersions: ["2026-07-28"],
            // No listChanged / subscribe: there is nothing to subscribe to.
            capabilities: { tools: {}, prompts: {}, resources: {} },
            serverInfo: { name: "stub", version: "1.0.0" },
          },
        }),
        { status: 200, headers: { "content-type": "application/json" } }
      );
    }) as unknown as typeof fetch;

    const config = normalize({ protocolVersion: "2026-07-28", fetchFn });
    const results = await runModernChecks(
      { config, serverUrl: SERVER_URL, fetchFn: config.fetchFn },
      new Set<MCPCheckId>([
        "modern-subscription-ack-precedes-notifications",
        "modern-subscription-filter-and-tagging",
        "modern-subscription-graceful-close",
      ])
    );

    expect(results).toHaveLength(3);
    for (const result of results) {
      expect(result.status).toBe("skipped");
      expect(result.error?.message).toMatch(
        /no subscribable notification type/
      );
    }
    // The discover answer alone settles it: no stream is opened.
    expect(methods).toEqual(["server/discover"]);
  });
});

describe("runProtocolChecks — era-aware invalid-method probe", () => {
  const selected = new Set<MCPCheckId>(["protocol-invalid-method-error"]);

  it("legacy: runs the initialize prelude then the bad-method POST", async () => {
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    const fetchFn = (async (url: unknown, init?: RequestInit) => {
      calls.push({ url: String(url), init });
      return calls.length === 1
        ? initializeResponse("sess-1")
        : jsonRpcErrorResponse();
    }) as unknown as typeof fetch;

    const config = normalize({ fetchFn });
    const results = await runProtocolChecks(
      { config, serverUrl: SERVER_URL, fetchFn: config.fetchFn },
      selected
    );

    expect(results).toHaveLength(1);
    expect(results[0]?.status).toBe("passed");
    expect(calls).toHaveLength(2);
    // Prelude is an initialize at the pinned (default) version.
    const initBody = JSON.parse(String(calls[0]?.init?.body));
    expect(initBody.method).toBe("initialize");
    expect(initBody.params.protocolVersion).toBe("2025-11-25");
    // The bad-method POST carries the session obtained from the prelude.
    const badHeaders = new Headers(calls[1]?.init?.headers as HeadersInit);
    expect(badHeaders.get("mcp-session-id")).toBe("sess-1");
  });

  it("legacy: uses the pinned stateful version in the initialize prelude", async () => {
    const calls: Array<RequestInit | undefined> = [];
    const fetchFn = (async (_url: unknown, init?: RequestInit) => {
      calls.push(init);
      return calls.length === 1 ? initializeResponse() : jsonRpcErrorResponse();
    }) as unknown as typeof fetch;

    const config = normalize({ fetchFn, protocolVersion: "2025-06-18" });
    await runProtocolChecks(
      { config, serverUrl: SERVER_URL, fetchFn: config.fetchFn },
      selected
    );

    const initBody = JSON.parse(String(calls[0]?.body));
    expect(initBody.params.protocolVersion).toBe("2025-06-18");
  });

  it("modern: drops the prelude and frames the POST with the modern envelope", async () => {
    const calls: Array<RequestInit | undefined> = [];
    const fetchFn = (async (_url: unknown, init?: RequestInit) => {
      calls.push(init);
      return jsonRpcErrorResponse();
    }) as unknown as typeof fetch;

    const config = normalize({ fetchFn, protocolVersion: "2026-07-28" });
    const results = await runProtocolChecks(
      { config, serverUrl: SERVER_URL, fetchFn: config.fetchFn },
      selected
    );

    expect(results[0]?.status).toBe("passed");
    // No initialize prelude — a single sessionless POST.
    expect(calls).toHaveLength(1);
    const headers = new Headers(calls[0]?.headers as HeadersInit);
    expect(headers.get("MCP-Protocol-Version")).toBe("2026-07-28");
    expect(headers.get("mcp-method")).toBe(
      "nonexistent/method_that_does_not_exist"
    );
    expect(headers.has("mcp-session-id")).toBe(false);
    const body = JSON.parse(String(calls[0]?.body));
    expect(body.method).toBe("nonexistent/method_that_does_not_exist");
    // Full 2026-07-28 per-request _meta envelope — a conforming modern server
    // rejects an incomplete envelope (-32602) before dispatching the method,
    // so all three keys must be present or the probe never reaches unknown-
    // method handling.
    expect(body.params._meta["io.modelcontextprotocol/protocolVersion"]).toBe(
      "2026-07-28"
    );
    expect(body.params._meta["io.modelcontextprotocol/clientInfo"]).toEqual({
      name: "mcpjam-sdk-conformance",
      version: "1.0.0",
    });
    expect(
      body.params._meta["io.modelcontextprotocol/clientCapabilities"]
    ).toEqual({});
  });

  it("modern: a customHeaders case-variant never blends into the probe pin", async () => {
    const calls: Array<RequestInit | undefined> = [];
    const fetchFn = (async (_url: unknown, init?: RequestInit) => {
      calls.push(init);
      return jsonRpcErrorResponse();
    }) as unknown as typeof fetch;

    // Case-variant collisions with the probe-owned pins. A plain object would
    // keep these as distinct keys and Fetch would concatenate the canonical
    // duplicates ("stale, __invalid__"); the Headers instance must REPLACE them.
    const config = normalize({
      fetchFn,
      protocolVersion: "2026-07-28",
      customHeaders: {
        "MCP-Method": "tools/list",
        "mcp-protocol-version": "1999-01-01",
      },
    });
    await runProtocolChecks(
      { config, serverUrl: SERVER_URL, fetchFn: config.fetchFn },
      selected
    );

    const headers = new Headers(calls[0]?.headers as HeadersInit);
    // No concatenation — the probe pin wins cleanly.
    expect(headers.get("mcp-method")).toBe(
      "nonexistent/method_that_does_not_exist"
    );
    expect(headers.get("MCP-Protocol-Version")).toBe("2026-07-28");
  });
});

describe("raw legacy-only checks are era-skipped on a modern run", () => {
  it("transport checks skip before any HTTP is attempted", async () => {
    let fetchCalled = false;
    const fetchFn = (async () => {
      fetchCalled = true;
      return new Response("{}");
    }) as unknown as typeof fetch;

    const config = normalize({ fetchFn, protocolVersion: "2026-07-28" });
    const selected = new Set<MCPCheckId>([
      "server-sse-polling-session",
      "server-accepts-multiple-post-streams",
      "server-sse-streams-functional",
    ]);
    const results = await runTransportChecks(
      { config, serverUrl: SERVER_URL, fetchFn: config.fetchFn },
      selected
    );

    expect(fetchCalled).toBe(false);
    expect(results).toHaveLength(3);
    for (const result of results) {
      expect(result.status).toBe("skipped");
      expect(result.error?.message).toMatch(/Not applicable to the modern era/);
    }
  });

  it("legacy-only transport MUSTs era-skip on a modern run while the both-era content-type check probes", async () => {
    const requests: string[] = [];
    const fetchFn = (async (
      _input: RequestInfo | URL,
      init?: RequestInit,
    ) => {
      requests.push(String(init?.method ?? "POST"));
      return new Response(
        JSON.stringify({ jsonrpc: "2.0", id: 1300, result: { tools: [] } }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    }) as unknown as typeof fetch;

    const config = normalize({ fetchFn, protocolVersion: "2026-07-28" });
    const selected = new Set<MCPCheckId>([
      "notification-post-accepted",
      "get-stream-or-405",
      "session-id-visible-ascii",
      "post-response-content-type",
    ]);
    const results = await runTransportChecks(
      { config, serverUrl: SERVER_URL, fetchFn: config.fetchFn },
      selected,
    );

    const byId = new Map(results.map((result) => [result.id, result]));
    for (const id of [
      "notification-post-accepted",
      "get-stream-or-405",
      "session-id-visible-ascii",
    ] as const) {
      expect(byId.get(id)?.status).toBe("skipped");
      expect(byId.get(id)?.skipReason).toBe("not-applicable");
      expect(byId.get(id)?.error?.message).toMatch(
        /Not applicable to the modern era/,
      );
    }
    expect(byId.get("post-response-content-type")?.status).toBe("passed");
    // Exactly one exchange: the modern tools/list probe. No legacy initialize
    // prelude is ever attempted on a modern run.
    expect(requests).toEqual(["POST"]);
  });

  it("localhost security checks skip before any socket is opened", async () => {
    const config = normalize({ protocolVersion: "2026-07-28" });
    const selected = new Set<MCPCheckId>([
      "localhost-host-rebinding-rejected",
      "localhost-host-valid-accepted",
    ]);
    const results = await runSecurityChecks(
      { config, serverUrl: SERVER_URL, fetchFn: config.fetchFn },
      selected
    );

    expect(results).toHaveLength(2);
    for (const result of results) {
      expect(result.status).toBe("skipped");
      expect(result.error?.message).toMatch(/Not applicable to the modern era/);
    }
  });
});
