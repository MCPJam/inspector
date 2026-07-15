/**
 * Phase 0 transport-gate spike (STATIC half) — "Keep MCPJam being MCPJam" plan.
 *
 * The harness writes `.mcp.json` entries as `type:"http"`, i.e. Claude Code's
 * in-sandbox MCP client speaks modern **Streamable HTTP** (single endpoint:
 * POST a JSON-RPC message → server replies with `application/json` OR an SSE
 * stream; optional standalone GET for server→client messages; `Mcp-Session-Id`
 * for session continuity).
 *
 * The reuse candidate `adapter-http` is the LEGACY HTTP+SSE transport (GET emits
 * an `endpoint` handshake to a separate `/messages` channel). This test pins,
 * in-process, exactly how much of a Streamable-HTTP client's contract the route
 * already satisfies — so the live E2B spike only has to confirm the genuinely
 * unknowable bits (does Claude Code's client tolerate them) rather than the
 * whole thing.
 *
 * VERDICT codified below:
 *  - Request/response path (initialize → tools/list → tools/call via POST):
 *    SATISFIED. POST returns a single `application/json` JSON-RPC response,
 *    which is a legal *stateless* Streamable-HTTP server reply.
 *  - Session continuity: the route returns NO `Mcp-Session-Id` header → a
 *    Streamable-HTTP client must treat it as stateless. Live unknown: does
 *    Claude Code's client accept a stateless server?
 *  - Server→client notifications (e.g. tools/list_changed): NOT delivered on
 *    the POST. They only flow on the legacy GET `endpoint`/`message` stream,
 *    which a Streamable-HTTP client won't drive. This caps the plan's
 *    "dynamic" tier at the transport layer (gate #3), independent of client
 *    behavior.
 */
import { describe, it, expect, beforeEach, vi } from "vitest";
import type { Hono } from "hono";
import {
  createMockMcpClientManager,
  createTestApp,
  expectJson,
  type MockMCPClientManager,
} from "./helpers/index.js";

// Headers a Streamable-HTTP client sends on every request. No Origin → in-process
// (tunneled) client, which the route serves without a session token.
const STREAMABLE_HTTP_HEADERS = {
  "Content-Type": "application/json",
  Accept: "application/json, text/event-stream",
};

describe("Phase 0 transport gate: adapter-http vs a Streamable-HTTP client", () => {
  let manager: MockMCPClientManager;
  let app: Hono;

  beforeEach(() => {
    vi.clearAllMocks();
    manager = createMockMcpClientManager({
      listServers: vi.fn().mockReturnValue(["test-server"]),
      getManagedClient: vi
        .fn()
        .mockImplementation((id: string) =>
          id === "test-server" ? {} : undefined,
        ),
      hasServer: vi.fn().mockImplementation((id: string) => id === "test-server"),
      getInitializationInfo: vi.fn().mockReturnValue({
        protocolVersion: "2025-06-18",
        transport: "http",
        serverCapabilities: { tools: { listChanged: true } },
        serverVersion: { name: "real-server", version: "1.2.3" },
        clientCapabilities: {},
      }),
      listTools: vi
        .fn()
        .mockResolvedValue({ tools: [{ name: "echo", inputSchema: {} }] }),
      executeTool: vi
        .fn()
        .mockResolvedValue({ content: [{ type: "text", text: "ok" }] }),
    });
    app = createTestApp(manager, ["adapter-http"], { withSecurity: true });
  });

  const post = (body: unknown) =>
    app.request("/api/mcp/adapter-http/test-server", {
      method: "POST",
      headers: STREAMABLE_HTTP_HEADERS,
      body: JSON.stringify(body),
    });

  it("SATISFIES the core request/response flow (initialize → tools/list → tools/call)", async () => {
    // initialize
    const initRes = await post({
      id: 1,
      method: "initialize",
      params: { protocolVersion: "2025-06-18" },
    });
    expect(initRes.status).toBe(200);
    // A Streamable-HTTP client accepts a single JSON reply to its POST.
    expect(initRes.headers.get("Content-Type")).toContain("application/json");
    {
      const { data } = await expectJson(initRes);
      expect(data.jsonrpc).toBe("2.0");
      expect(data.result.protocolVersion).toBe("2025-06-18");
      expect(data.result.serverInfo.name).toBe("real-server");
    }

    // tools/list
    const listRes = await post({ id: 2, method: "tools/list", params: {} });
    {
      const { status, data } = await expectJson(listRes);
      expect(status).toBe(200);
      expect(data.result.tools).toEqual([{ name: "echo", inputSchema: {} }]);
    }

    // tools/call
    const callRes = await post({
      id: 3,
      method: "tools/call",
      params: { name: "echo", arguments: { text: "hi" } },
    });
    {
      const { status, data } = await expectJson(callRes);
      expect(status).toBe(200);
      expect(data.result.content).toEqual([{ type: "text", text: "ok" }]);
    }
  });

  it("returns NO Mcp-Session-Id header → a Streamable-HTTP client must treat the server as stateless (LIVE-SPIKE UNKNOWN: does Claude Code accept that?)", async () => {
    const res = await post({
      id: 1,
      method: "initialize",
      params: { protocolVersion: "2025-06-18" },
    });
    expect(res.status).toBe(200);
    // Documents the gap: the route is stateless-only. If a future change adds
    // session continuity, flip this assertion and echo the header on POSTs.
    expect(res.headers.get("Mcp-Session-Id")).toBeNull();
  });

  it("GET is the LEGACY endpoint-handshake, not a Streamable-HTTP server stream → server→client notifications won't reach the harness this way (caps the dynamic tier, gate #3)", async () => {
    const res = await app.request("/api/mcp/adapter-http/test-server", {
      method: "GET",
    });
    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toBe("text/event-stream");

    // Drain the handshake: legacy transport advertises a separate POST channel
    // via an `endpoint` event. A Streamable-HTTP client does NOT consume this;
    // it expects this GET to be a raw stream of server JSON-RPC messages.
    const reader = res.body!.getReader();
    const decoder = new TextDecoder();
    let buf = "";
    for (let i = 0; i < 12; i++) {
      const { value, done } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      // The `data:` line carrying the URL arrives a chunk after its
      // `event: endpoint` line, so wait for the URL itself.
      if (buf.includes("/messages")) break;
    }
    await reader.cancel();
    expect(buf).toContain("event: endpoint");
    expect(buf).toContain("/messages");
  });
});
