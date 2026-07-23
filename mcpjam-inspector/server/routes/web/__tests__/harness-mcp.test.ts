/**
 * Hosted-plane `/api/web/harness-mcp/:serverId` route.
 *
 * Mocks `./auth` (createAuthorizedManager + withManager) so the route doesn't
 * hit Convex; uses a REAL signed token and the REAL JSON-RPC bridge over a mock
 * authorized manager. Verifies the token gate (REQUIRED + identity + serverId
 * scope) and that a valid web token forwards through the bridge.
 */
import { describe, it, expect, beforeAll, vi } from "vitest";
import { Hono } from "hono";

// vi.hoisted so the mock manager exists when the hoisted vi.mock factory runs.
const { mockManager } = vi.hoisted(() => ({
  mockManager: {
    listTools: vi.fn().mockResolvedValue({ tools: [{ name: "echo" }] }),
    getInitializationInfo: () => ({
      protocolVersion: "2025-06-18",
      serverCapabilities: { tools: { listChanged: true } },
      serverVersion: { name: "real-server", version: "1.0.0" },
      clientCapabilities: {},
    }),
    disconnectAllServers: vi.fn(),
  },
}));

vi.mock("../auth", () => ({
  createAuthorizedManager: vi.fn().mockResolvedValue({ manager: mockManager }),
  withManager: async (
    mp: Promise<any>,
    fn: (m: any) => Promise<any>,
  ): Promise<any> => {
    const r = await mp;
    return fn(r.manager ?? r);
  },
}));

import { harnessMcp } from "../harness-mcp.js";
import { signTestProxyToken } from "../../../utils/harness/__tests__/sign-test-token.js";

beforeAll(() => {
  process.env.COMPUTERS_TERMINAL_TOKEN_SECRET = "test-harness-proxy-secret-32-chars";
});

const app = new Hono();
app.route("/api/web/harness-mcp", harnessMcp);

const webToken = (serverId: string) =>
  signTestProxyToken({
    serverId,
    projectId: "p1",
    externalId: "user_ext_1",
    orgId: "org_1",
  });

const post = (serverId: string, headers: Record<string, string> = {}) =>
  app.request(`/api/web/harness-mcp/${serverId}`, {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "tools/list",
      params: {},
    }),
  });

describe("/api/web/harness-mcp", () => {
  it("401s without a token (token IS the auth here)", async () => {
    expect((await post("srv-a")).status).toBe(401);
  });

  it("401s a token missing the delegated identity (externalId)", async () => {
    const noIdentity = signTestProxyToken({ serverId: "srv-a", externalId: "" });
    const res = await post("srv-a", { "X-MCPJam-Proxy-Token": noIdentity });
    expect(res.status).toBe(401);
  });

  it("401s a token minted for a different server", async () => {
    const res = await post("srv-a", { "X-MCPJam-Proxy-Token": webToken("srv-b") });
    expect(res.status).toBe(401);
  });

  it("200s and forwards tools/list through the bridge with a valid web token", async () => {
    const res = await post("srv-a", { "X-MCPJam-Proxy-Token": webToken("srv-a") });
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.jsonrpc).toBe("2.0");
    expect(data.result.tools).toEqual([{ name: "echo" }]);
    expect(mockManager.listTools).toHaveBeenCalledWith("srv-a");
  });

  const postRaw = (bodyText: string) =>
    app.request(`/api/web/harness-mcp/srv-a`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "X-MCPJam-Proxy-Token": webToken("srv-a"),
      },
      body: bodyText,
    });

  it("returns a JSON-RPC -32700 parse error for garbage bytes (NOT 202)", async () => {
    const res = await postRaw("this is not json {{{");
    expect(res.status).toBe(400);
    const data = await res.json();
    expect(data).toEqual({
      jsonrpc: "2.0",
      id: null,
      error: { code: -32700, message: "Parse error" },
    });
  });

  it("returns a JSON-RPC -32600 invalid request when method is missing (NOT 202)", async () => {
    const res = await postRaw(JSON.stringify({ id: 7, params: {} }));
    expect(res.status).toBe(400);
    const data = await res.json();
    expect(data.error.code).toBe(-32600);
    expect(data.id).toBe(7);
  });

  it("returns -32600 for non-object JSON bodies (null, arrays, scalars)", async () => {
    for (const bodyText of ["null", "[]", '"hi"', "42"]) {
      const res = await postRaw(bodyText);
      expect(res.status).toBe(400);
      const data = await res.json();
      expect(data.error.code).toBe(-32600);
      expect(data.id).toBe(null);
    }
  });

  // #3041 review: a JSON-RPC batch (top-level array) is not a supported MCP
  // message (MCP 2025-06-18 removed batching; the bridge handles one request).
  it("returns -32600 with id null for a JSON-RPC batch array (NOT 202)", async () => {
    const res = await postRaw(
      JSON.stringify([{ jsonrpc: "2.0", id: 1, method: "tools/list" }]),
    );
    expect(res.status).toBe(400);
    const data = await res.json();
    expect(data.error.code).toBe(-32600);
    expect(data.id).toBe(null);
  });

  // #3041 review: a PRESENT but wrong `jsonrpc` version is malformed → -32600.
  it("returns -32600 for a present but invalid `jsonrpc` version", async () => {
    const res = await postRaw(
      JSON.stringify({ jsonrpc: "1.0", id: 5, method: "tools/list" }),
    );
    expect(res.status).toBe(400);
    const data = await res.json();
    expect(data.error.code).toBe(-32600);
    expect(data.id).toBe(5);
  });

  // ...but an ABSENT `jsonrpc` is tolerated (spec-lenient tunneled clients):
  // a valid method still forwards through the bridge, it is NOT rejected.
  it("tolerates an absent `jsonrpc` when the method is valid (forwards, no -32600)", async () => {
    const res = await postRaw(
      JSON.stringify({ id: 8, method: "tools/list", params: {} }),
    );
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.result.tools).toEqual([{ name: "echo" }]);
  });

  // #3041 review: an invalid `id` (object/array) must be normalized to null in
  // the error response so it stays valid JSON-RPC the client can parse.
  it("normalizes a non-scalar id to null in the error response", async () => {
    const res = await postRaw(
      JSON.stringify({ jsonrpc: "2.0", id: { bad: 1 }, params: {} }),
    );
    expect(res.status).toBe(400);
    const data = await res.json();
    expect(data.error.code).toBe(-32600);
    expect(data.id).toBe(null);
  });

  // #3041 re-review: a non-scalar `id` on an otherwise-VALID request must be
  // rejected at the gate — else it reaches the bridge and gets echoed verbatim
  // into a SUCCESS response, emitting an invalid JSON-RPC id.
  it("rejects a non-scalar id even when the method is valid (NOT a 200)", async () => {
    const res = await postRaw(
      JSON.stringify({ jsonrpc: "2.0", id: {}, method: "tools/list" }),
    );
    expect(res.status).toBe(400);
    const data = await res.json();
    expect(data.error.code).toBe(-32600);
    expect(data.id).toBe(null);
  });

  // #3041 re-review: non-structured `params` (a scalar) is invalid per JSON-RPC.
  it("rejects non-structured params (scalar) even with a valid method", async () => {
    const res = await postRaw(
      JSON.stringify({ jsonrpc: "2.0", id: 3, method: "tools/list", params: 5 }),
    );
    expect(res.status).toBe(400);
    const data = await res.json();
    expect(data.error.code).toBe(-32600);
    expect(data.id).toBe(3);
  });

  it("still 202s a real notification (method present, no id)", async () => {
    const res = await postRaw(
      JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }),
    );
    expect(res.status).toBe(202);
  });

  it("wires an rpcLogger that publishes the sandbox's MCP traffic to the rpc-log bus", async () => {
    const { createAuthorizedManager } = await import("../auth");
    const { rpcLogBus } = await import("../../../services/rpc-log-bus.js");
    (createAuthorizedManager as ReturnType<typeof vi.fn>).mockClear();

    const res = await post("srv-a", { "X-MCPJam-Proxy-Token": webToken("srv-a") });
    expect(res.status).toBe(200);

    // 8th arg = options; the route must hand the manager a logger that lands
    // on the shared bus (the live harness turn bridges the bus into its
    // collector — see bridgeHarnessRpcLogsToCollector).
    const options = (createAuthorizedManager as ReturnType<typeof vi.fn>).mock
      .calls[0]?.[7] as { rpcLogger?: (e: unknown) => void } | undefined;
    expect(typeof options?.rpcLogger).toBe("function");

    const seen: unknown[] = [];
    const stop = rpcLogBus.subscribe(["srv-a"], (e) => seen.push(e));
    try {
      options!.rpcLogger!({
        direction: "send",
        serverId: "srv-a",
        message: { jsonrpc: "2.0", id: 9, method: "tools/call" },
      });
    } finally {
      stop();
    }
    expect(seen).toHaveLength(1);
    expect(seen[0]).toMatchObject({ serverId: "srv-a", direction: "send" });
  });
});
