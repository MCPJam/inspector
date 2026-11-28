/**
 * The client rules behind the three concurrent requests of Functional SSE
 * Streams, pinned as tests on what MCPJam sends.
 *
 * Multiple POST Streams used to grade the server on "The client MAY remain
 * connected to multiple SSE streams simultaneously". That sentence is about
 * the client, so the check is gone and the rule is tested here instead, on our
 * own side of the wire, together with the client MUSTs every one of those
 * requests has to keep (2025 `basic/transports.mdx` and `basic/index.mdx`):
 *
 *   - "The client MUST use HTTP POST to send JSON-RPC messages to the MCP
 *     endpoint."
 *   - "The client MUST include an `Accept` header, listing both
 *     `application/json` and `text/event-stream` as supported content types."
 *   - "If an `MCP-Session-Id` is returned by the server during initialization,
 *     clients using the Streamable HTTP transport MUST include it in the
 *     `MCP-Session-Id` header on all of their subsequent HTTP requests."
 *   - "the client MUST include the `MCP-Protocol-Version: <protocol-version>`
 *     HTTP header on all subsequent requests" (2025-06-18 and later).
 *   - "Requests MUST include a string or integer ID", "the ID MUST NOT be
 *     `null`", and it "MUST NOT have been previously used by the requestor
 *     within the same session."
 *
 * The scripted server answers none of the three until all three are waiting.
 * A client that sent them one after another would never be answered.
 */

import { describe, expect, it } from "vitest";
import { runTransportChecks } from "../../src/mcp-conformance/checks/transport.js";
import type {
  MCPCheckId,
  RawHttpCheckContext,
} from "../../src/mcp-conformance/types.js";
import { normalizeMCPConformanceConfig } from "../../src/mcp-conformance/validation.js";

const SSE: MCPCheckId = "server-sse-streams-functional";
const SESSION_ID = "session-for-three-streams";
const LEGACY_VERSIONS = ["2025-03-26", "2025-06-18", "2025-11-25"] as const;

interface SeenRequest {
  httpMethod: string;
  headers: Headers;
  body?: Record<string, unknown>;
}

function json(payload: unknown, headers: Record<string, string> = {}) {
  return new Response(JSON.stringify(payload), {
    status: 200,
    headers: { "content-type": "application/json", ...headers },
  });
}

/**
 * A 2025-era server as a scripted `fetch`. It holds every `tools/list` until
 * three of them are waiting, then answers each on an SSE stream of its own.
 */
function gatedServer() {
  const seen: SeenRequest[] = [];
  const waiting: Array<() => void> = [];
  let peak = 0;

  const fetchFn = (async (_input: RequestInfo | URL, init?: RequestInit) => {
    const httpMethod = String(init?.method ?? "GET").toUpperCase();
    const headers = new Headers(init?.headers);
    const body =
      typeof init?.body === "string"
        ? (JSON.parse(init.body) as Record<string, unknown>)
        : undefined;
    seen.push({ httpMethod, headers, body });

    if (httpMethod !== "POST") return new Response(null, { status: 200 });
    if (body?.method === "initialize") {
      const params = body.params as { protocolVersion: string };
      return json(
        {
          jsonrpc: "2.0",
          id: body.id,
          result: {
            protocolVersion: params.protocolVersion,
            capabilities: { tools: {} },
            serverInfo: { name: "gated", version: "1.0.0" },
          },
        },
        { "mcp-session-id": SESSION_ID },
      );
    }
    if (body?.id === undefined) return new Response(null, { status: 202 });

    // The gate: nobody is answered until three streams are open at once.
    await new Promise<void>((resolve) => {
      waiting.push(resolve);
      peak = Math.max(peak, waiting.length);
      if (waiting.length === 3) {
        for (const release of waiting.splice(0)) release();
      }
    });
    const event = JSON.stringify({
      jsonrpc: "2.0",
      id: body.id,
      result: { tools: [] },
    });
    return new Response(`event: message\ndata: ${event}\n\n`, {
      status: 200,
      headers: { "content-type": "text/event-stream" },
    });
  }) as typeof fetch;

  return { fetchFn, seen, peak: () => peak };
}

async function run(protocolVersion: (typeof LEGACY_VERSIONS)[number]) {
  const server = gatedServer();
  const config = normalizeMCPConformanceConfig({
    serverUrl: "https://gated.example.test/mcp",
    protocolVersion,
    checkTimeout: 1_500,
    fetchFn: server.fetchFn,
  });
  const ctx: RawHttpCheckContext = {
    config,
    serverUrl: config.serverUrl,
    fetchFn: config.fetchFn,
  };
  const results = await runTransportChecks(ctx, new Set([SSE]));
  const probes = server.seen.filter(
    (request) => request.body?.method === "tools/list",
  );
  return { results, probes, server };
}

describe.each(LEGACY_VERSIONS)("the three concurrent requests on %s", (version) => {
  it("are open at the same time, each on a stream of its own", async () => {
    const { results, probes, server } = await run(version);

    expect(probes).toHaveLength(3);
    // "The client MAY remain connected to multiple SSE streams simultaneously."
    expect(server.peak()).toBe(3);
    const [sse] = results;
    expect(sse?.status).toBe("passed");
    expect(sse?.details).toMatchObject({ sseStreamCount: 3 });
  });

  it("are POSTs that accept both JSON and an event stream", async () => {
    const { probes } = await run(version);

    for (const probe of probes) {
      expect(probe.httpMethod).toBe("POST");
      const accept = probe.headers.get("accept") ?? "";
      expect(accept).toContain("application/json");
      expect(accept).toContain("text/event-stream");
    }
  });

  it("carry the session id the server gave at initialize", async () => {
    const { probes } = await run(version);

    expect(probes.map((probe) => probe.headers.get("mcp-session-id"))).toEqual([
      SESSION_ID,
      SESSION_ID,
      SESSION_ID,
    ]);
  });

  it("each use a request id nothing else on the session has used", async () => {
    const { probes, server } = await run(version);

    const ids = probes.map((probe) => probe.body?.id);
    for (const id of ids) {
      expect(["string", "number"]).toContain(typeof id);
    }
    expect(new Set(ids).size).toBe(3);
    const earlier = server.seen
      .filter((request) => request.body?.method === "initialize")
      .map((request) => request.body?.id);
    for (const id of ids) expect(earlier).not.toContain(id);
  });

  it("produce no result for the check that used to grade them", async () => {
    const { results } = await run(version);

    expect(results.map((result) => result.id)).toEqual([SSE]);
  });
});

describe.each(["2025-06-18", "2025-11-25"] as const)(
  "the protocol version header on %s",
  (version) => {
    it("is on each of the three requests", async () => {
      const { probes } = await run(version);

      expect(
        probes.map((probe) => probe.headers.get("mcp-protocol-version")),
      ).toEqual([version, version, version]);
    });
  },
);
