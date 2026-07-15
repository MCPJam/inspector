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
    body: JSON.stringify({ id: 1, method: "tools/list", params: {} }),
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
