/**
 * Client rules about versions, eras and error codes: what MCPJam does when a
 * server answers with a version it does not support, an unknown result type,
 * a modern error where a legacy client would fall back, or a code from the
 * reserved range.
 *
 * Servers here are the dual-era fixture and the legacy mock, with answers
 * rewritten at the fetch seam, plus small scripted servers where no fixture
 * can say the thing a rule is about.
 */

import http from "node:http";
import type { AddressInfo } from "node:net";
import { describe, expect } from "vitest";
import { toNodeHandler } from "@modelcontextprotocol/node";
import { CHECK_ERAS, MCP_CHECK_IDS } from "../../src/mcp-conformance/index.js";
import { MCPClientManager } from "../../src/mcp-client-manager/index.js";
import { runUndeclaredProbe } from "../../src/tasks-conformance/evidence.js";
import { createFixtureHandler } from "../support/dual-era-fixture.js";
import {
  startConformanceMockServer,
  type ConformanceMockRequest,
} from "../mock-servers/conformance-mcp-server.js";
import {
  exercised,
  expectKnownViolations,
  recordingFetch,
  rpcMethodOf,
  ruleTest,
  runOneCheck,
  violationsByCheck,
  type WireRequest,
} from "./harness.js";

type Handler = (request: Request) => Promise<Response>;

const SERVER_INFO_KEY = "io.modelcontextprotocol/serverInfo";

/**
 * Rewrite the answer to one JSON-RPC method; other traffic passes through.
 * Handles both answer forms: a JSON body, and an SSE stream whose `data:`
 * lines carry the JSON-RPC response (the fixture picks per request).
 */
function rewriting(
  inner: Handler,
  method: string,
  edit: (body: { result?: Record<string, unknown> }) => void,
): Handler {
  return async (request) => {
    const sent = request.method === "POST"
      ? await request.clone().json().catch(() => undefined)
      : undefined;
    const response = await inner(request);
    if (sent?.method !== method) return response;
    const text = await response.text();
    const editMessage = (json: string) => {
      const message = JSON.parse(json);
      if (message && typeof message === "object" && "result" in message) edit(message);
      return JSON.stringify(message);
    };
    const rewritten = response.headers.get("content-type")?.includes("text/event-stream")
      ? text
          .split("\n")
          .map((line) => (line.startsWith("data: {") ? `data: ${editMessage(line.slice(6))}` : line))
          .join("\n")
      : editMessage(text);
    const headers = new Headers(response.headers);
    headers.delete("content-length");
    return new Response(rewritten, { status: response.status, headers });
  };
}

/** Serve a fetch handler on a real localhost port, so `node:http` probes reach it too. */
async function serve(handler: Handler): Promise<{ url: string; close: () => Promise<void> }> {
  const server = http.createServer(toNodeHandler({ fetch: handler } as never));
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}/mcp`,
    close: () =>
      new Promise<void>((resolve) => {
        server.close(() => resolve());
        server.closeAllConnections();
      }),
  };
}

const LEGACY_CHECKS = MCP_CHECK_IDS.filter((id) => CHECK_ERAS[id].includes("legacy"));
const MODERN_CHECKS = MCP_CHECK_IDS.filter((id) => CHECK_ERAS[id].includes("modern"));

/** Checks known to break a rule, by rule id. Absent means none does. */
const KNOWN: Record<string, string[]> = {};

describe("a server that answers initialize with a version MCPJam does not support", () => {
  ruleTest(
    "C004",
    "no check sends anything after initialize but the DELETE that ends the session",
    async () => {
      const sent: WireRequest[] = [];
      let current = "";
      const fixture = createFixtureHandler();
      const handler = recordingFetch(
        rewriting((request) => fixture.fetch(request), "initialize", (body) => {
          body.result!.protocolVersion = "2099-01-01";
        }),
        sent,
        () => current,
      );
      const server = await serve((request) => handler(request));
      try {
        for (const check of LEGACY_CHECKS) {
          current = check;
          await runOneCheck(check, { serverUrl: server.url, protocolVersion: "2025-11-25" });
        }
      } finally {
        await server.close();
      }
      expect(sent.some((request) => rpcMethodOf(request) === "initialize")).toBe(true);
      expectKnownViolations(
        violationsByCheck(sent, (request) => {
          const method = rpcMethodOf(request);
          if (method === "initialize" || request.httpMethod === "DELETE") return undefined;
          return `kept going: sent ${request.httpMethod} ${method ?? ""}`.trim();
        }),
        KNOWN.C004,
      );
    },
    120_000,
  );
});

describe("server identity does not steer the client", () => {
  /** Per check, what went out, order-free (the client fans some requests out at once). */
  async function wireShape(
    checks: readonly string[],
    protocolVersion: "2025-11-25" | "2026-07-28",
    handler: Handler,
  ): Promise<Map<string, string[]>> {
    const shapes = new Map<string, string[]>();
    for (const check of checks) {
      const sent: WireRequest[] = [];
      await runOneCheck(check, {
        serverUrl: "http://localhost/mcp",
        protocolVersion,
        fetchFn: recordingFetch(handler, sent, () => check),
      });
      shapes.set(
        check,
        sent
          .map((request) =>
            [
              request.httpMethod,
              rpcMethodOf(request) ?? "-",
              request.headers["mcp-method"] ?? "",
              request.headers["mcp-name"] ?? "",
              request.headers["mcp-protocol-version"] ?? "",
              // The whole message minus its id, which only numbers requests.
              JSON.stringify({ ...(request.body as object), id: undefined }),
            ]
              .join(" ")
              // Some probes name a made-up target stamped with the time.
              .replace(/\d{10,}/g, "<time>"),
          )
          .sort(),
      );
    }
    return shapes;
  }

  const OTHER_IDENTITY = { name: "a-completely-different-server", version: "9.9.9" };

  function expectSameWire(before: Map<string, string[]>, after: Map<string, string[]>) {
    const differing = [...before.keys()].filter(
      (check) => JSON.stringify(before.get(check)) !== JSON.stringify(after.get(check)),
    );
    expect(
      differing,
      differing
        .map((check) => `${check}\n  before: ${before.get(check)!.join(" | ")}\n  after:  ${after.get(check)!.join(" | ")}`)
        .join("\n"),
    ).toEqual([]);
  }

  ruleTest(
    "C035",
    "changing only serverInfo changes nothing the client sends (2026-07-28)",
    async () => {
      const fixture = createFixtureHandler();
      const plain: Handler = (request) => fixture.fetch(request);
      const renamed = rewriting(plain, "server/discover", (body) => {
        const meta = body.result!._meta as Record<string, unknown>;
        meta[SERVER_INFO_KEY] = OTHER_IDENTITY;
      });
      const before = await wireShape(MODERN_CHECKS, "2026-07-28", plain);
      const after = await wireShape(MODERN_CHECKS, "2026-07-28", renamed);
      expectSameWire(before, after);
    },
    120_000,
  );

  ruleTest(
    "C035",
    "changing only serverInfo changes nothing the client sends (2025-11-25)",
    async () => {
      const fixture = createFixtureHandler();
      const plain: Handler = (request) => fixture.fetch(request);
      const renamed = rewriting(plain, "initialize", (body) => {
        body.result!.serverInfo = OTHER_IDENTITY;
      });
      // The localhost security checks dial node:http and need a real port.
      const checks = LEGACY_CHECKS.filter((id) => !id.startsWith("localhost-host-"));
      const before = await wireShape(checks, "2025-11-25", plain);
      const after = await wireShape(checks, "2025-11-25", renamed);
      expectSameWire(before, after);
    },
    120_000,
  );
});

describe("unknown result types", () => {
  async function connectModern(handler: Handler) {
    const manager = new MCPClientManager();
    const connected = manager.connectToServer("fixture", {
      url: "http://localhost/mcp",
      mcpProtocolVersion: "2026-07-28",
      baseFetch: (input, init) => handler(new Request(input, init)),
      timeout: 10_000,
    });
    return { manager, connected };
  }

  ruleTest(
    "C036",
    "the client refuses a server/discover answer with an unknown resultType",
    async () => {
      const fixture = createFixtureHandler();
      const { manager, connected } = await connectModern(
        rewriting((request) => fixture.fetch(request), "server/discover", (body) => {
          body.result!.resultType = "partial";
        }),
      );
      try {
        await expect(connected).rejects.toThrow(/partial/);
      } finally {
        await manager.disconnectAllServers().catch(() => {});
      }
    },
  );

  ruleTest(
    "C036",
    "the client refuses a tools/list answer with an unknown resultType",
    async () => {
      const fixture = createFixtureHandler();
      const { manager, connected } = await connectModern(
        rewriting((request) => fixture.fetch(request), "tools/list", (body) => {
          body.result!.resultType = "partial";
        }),
      );
      try {
        await connected;
        await expect(manager.listTools("fixture")).rejects.toThrow();
      } finally {
        await manager.disconnectAllServers().catch(() => {});
      }
    },
  );

  ruleTest.knownBreak(
    "C036",
    "the raw result-type check accepts tools/list answering an unknown resultType",
    "checks/modern.ts:857 (runResultTypeCheck) only asks for a non-empty string, so it passes resultType \"partial\"",
    async () => {
      const fixture = createFixtureHandler();
      const run = await runOneCheck("modern-result-type-present", {
        serverUrl: "http://localhost/mcp",
        protocolVersion: "2026-07-28",
        fetchFn: (input, init) =>
          rewriting((request) => fixture.fetch(request), "tools/list", (body) => {
            body.result!.resultType = "partial";
          })(new Request(input, init)),
      });
      expect(run.check?.status).toBe("passed");
      expect(
        (run.check?.details as { resultTypes?: Record<string, unknown> })?.resultTypes?.["tools/list"],
      ).toBe("partial");
    },
  );
});

describe("telling a modern server from a legacy one", () => {
  /** A request as an unpinned connect sent it: HTTP method and parsed body. */
  interface Sent {
    httpMethod: string;
    body?: { method?: string; params?: { protocolVersion?: string } };
  }

  /**
   * An unpinned connect against a scripted server. `answer` gets each POST's
   * JSON-RPC method; any other HTTP method gets 405.
   */
  async function unpinnedConnect(
    answer: (method: string | undefined, id: unknown) => Response,
  ): Promise<Sent[]> {
    const sent: Sent[] = [];
    const manager = new MCPClientManager();
    try {
      await manager
        .connectToServer("server", {
          url: "http://localhost/mcp",
          timeout: 5_000,
          baseFetch: async (input, init) => {
            const request = new Request(input, init);
            const body = request.method === "POST"
              ? await request.clone().json().catch(() => undefined)
              : undefined;
            sent.push({ httpMethod: request.method, body });
            if (request.method !== "POST") return new Response(null, { status: 405 });
            return answer(body?.method, body?.id);
          },
        })
        .catch(() => {});
    } finally {
      await manager.disconnectAllServers().catch(() => {});
    }
    return sent;
  }

  /** The modern "protocol version not supported" error, listing `supported`. */
  function versionRefusal(id: unknown, supported: string[]): Response {
    return Response.json(
      {
        jsonrpc: "2.0",
        id,
        error: {
          code: -32022,
          message: "Unsupported protocol version: 2026-07-28",
          data: { supported, requested: "2026-07-28" },
        },
      },
      { status: 400 },
    );
  }

  const LEGACY_INITIALIZE_ANSWER = (id: unknown) =>
    Response.json(
      {
        jsonrpc: "2.0",
        id,
        result: {
          protocolVersion: "2025-11-25",
          capabilities: { tools: {} },
          serverInfo: { name: "client-rules-scripted", version: "1" },
        },
      },
      { headers: { "mcp-session-id": "session-1" } },
    );

  ruleTest(
    "C046",
    "a 400 whose body is a modern error is read, and the client does not fall back to initialize",
    async () => {
      const sent = await unpinnedConnect((method, id) => versionRefusal(id, ["2099-01-01"]));
      expect(sent[0]?.body?.method).toBe("server/discover");
      expect(sent.filter((request) => request.body?.method === "initialize")).toEqual([]);
    },
  );

  ruleTest(
    "C046",
    "a 400 whose body is not a modern error falls back to the initialize handshake",
    async () => {
      const received: ConformanceMockRequest[] = [];
      const server = await startConformanceMockServer({
        onRequest: (record) => received.push(record),
      });
      try {
        await runOneCheck("server-initialize", { serverUrl: server.url });
      } finally {
        await server.stop();
      }
      const methods = received.map(
        (record) => (record.body as { method?: string } | undefined)?.method ?? record.method,
      );
      // The modern probe went first, got the legacy server's 400, and the
      // client then fell back to initialize.
      expect(methods[0]).toBe("server/discover");
      expect(methods).toContain("initialize");
    },
  );

  ruleTest(
    "C050",
    "after a modern version error with no shared version, the client falls back to nothing",
    async () => {
      const sent = await unpinnedConnect((method, id) => versionRefusal(id, ["2099-01-01"]));
      // Neither the 2025 handshake nor the old HTTP+SSE transport.
      expect(sent.filter((request) => request.body?.method === "initialize")).toEqual([]);
      expect(sent.filter((request) => request.httpMethod === "GET")).toEqual([]);
    },
  );

  ruleTest(
    "C050",
    "after a modern version error that lists a shared version, the client retries with it",
    async () => {
      const sent = await unpinnedConnect((method, id) =>
        method === "server/discover"
          ? versionRefusal(id, ["2099-01-01", "2025-11-25"])
          : method === "initialize"
            ? LEGACY_INITIALIZE_ANSWER(id)
            : new Response(null, { status: 202 }),
      );
      const retry = sent.find((request) => request.body?.method === "initialize");
      expect(retry?.body?.params?.protocolVersion).toBe("2025-11-25");
    },
  );

  ruleTest(
    "C052",
    "an unpinned run works against a server with sessions and against one without",
    async (context) => {
      const legacyRecords: ConformanceMockRequest[] = [];
      const legacy = await startConformanceMockServer({
        onRequest: (record) => legacyRecords.push(record),
      });
      let legacyStatus: string | undefined;
      try {
        legacyStatus = (await runOneCheck("tools-list", { serverUrl: legacy.url })).check?.status;
      } finally {
        await legacy.stop();
      }
      const fixture = createFixtureHandler();
      const modern = await runOneCheck("tools-list", {
        serverUrl: "http://localhost/mcp",
        fetchFn: (input, init) => fixture.fetch(new Request(input, init)),
      });
      exercised(
        context,
        legacyRecords.some((record) => record.mintedSessionId) &&
          modern.result.protocolVersion === "2026-07-28",
        "the two servers did not end up as one with sessions and one without",
      );
      expect(legacyStatus).toBe("passed");
      expect(modern.check?.status).toBe("passed");
    },
  );

  ruleTest.knownBreak(
    "C053",
    "a 404 carrying a JSON-RPC method-not-found is still followed by the old HTTP+SSE GET",
    "MCPClientManager only treats a -32022 version refusal as proof of a modern server; a 404 with a -32601 body still reaches the HTTP+SSE fallback (MCPClientManager.ts:3807)",
    async () => {
      const sent = await unpinnedConnect((method, id) =>
        Response.json(
          { jsonrpc: "2.0", id, error: { code: -32601, message: "Method not found" } },
          { status: 404 },
        ),
      );
      expect(sent[0]?.body?.method).toBe("server/discover");
      expect(sent.some((request) => request.httpMethod === "GET")).toBe(true);
    },
  );

  ruleTest(
    "C053",
    "a 404 with no JSON-RPC body is treated as an old HTTP+SSE server: the GET is tried",
    async () => {
      const sent = await unpinnedConnect(() => new Response("Not Found", { status: 404 }));
      expect(sent.some((request) => request.httpMethod === "GET")).toBe(true);
    },
  );
});

describe("codes in the reserved legacy range", () => {
  ruleTest.knownBreak(
    "C055",
    "a server's -32001 is read as a timeout (\"no-response\")",
    "tasks-conformance/evidence.ts:308 turns every -32001 into \"no-response\" (\"produced no JSON-RPC rejection\"); the SDK's own timeout uses the same code, so a server-sent -32001 is misread",
    async () => {
      const sent: unknown[] = [];
      const probe = await runUndeclaredProbe(
        async (payload) => {
          sent.push({ jsonrpc: "2.0", id: 1, ...payload });
          // What the client surfaces when the SERVER answered with -32001.
          throw Object.assign(new Error("Server declined: busy"), { code: -32001 });
        },
        sent,
        "tasks/get",
        { taskId: "t1" },
      );
      expect(probe.outcome).toBe("no-response");
      expect(probe.code).toBe(-32001);
    },
  );
});
