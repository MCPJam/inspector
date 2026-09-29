import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Hono } from "hono";
import { adapterHttp, managerHttp } from "../http-adapters.js";
import { sessionAuthMiddleware } from "../../../middleware/session-auth.js";
import { generateSessionToken } from "../../../services/session-token.js";
import { tunnelManager } from "../../../services/tunnel-manager.js";

const rpc = { jsonrpc: "2.0", id: 1, method: "tools/list" };
describe("bridge credential boundary", () => {
  let app: Hono;
  let token: string;
  const manager = {
    hasServer: (id: string) => ["A", "B"].includes(id),
    listServers: () => ["A", "B"],
    getManagedClient: () => ({}),
    listTools: vi.fn(async () => ({ tools: [] })),
    executeTool: vi.fn(async () => ({ content: [] })),
    addNotificationHandler: vi.fn(),
  };
  beforeEach(() => {
    token = generateSessionToken();
    vi.clearAllMocks();
    vi.spyOn(tunnelManager, "verifyTunnelSecret").mockImplementation(
      (scope, id, secret) =>
        scope === "adapter-http" && id === "A" && secret === "secret-A",
    );
    app = new Hono();
    app.use("*", async (c, next) => {
      (c as any).mcpClientManager = manager;
      await next();
    });
    app.use("*", sessionAuthMiddleware);
    app.route("/api/mcp/adapter-http", adapterHttp);
    app.route("/api/mcp/manager-http", managerHttp);
  });
  afterEach(() => vi.restoreAllMocks());
  const post = (
    url: string,
    body = rpc,
    headers: Record<string, string> = {},
  ) =>
    app.request(url, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...headers },
      body: JSON.stringify(body),
    });

  for (const prefix of ["adapter-http", "manager-http"]) {
    for (const method of ["GET", "HEAD", "POST"]) {
      it(`rejects unauthenticated ${method} ${prefix} including forged forwarding headers`, async () => {
        const response = await app.request(`/api/mcp/${prefix}/A`, {
          method,
          headers: {
            Host: "localhost",
            "X-Forwarded-Host": "a.tunnels.mcpjam.com",
          },
        });
        expect(response.status).toBe(401);
        expect(response.headers.get("X-MCPJam-Session")).toBe("missing");
        expect(manager.listTools).not.toHaveBeenCalled();
      });
    }
    it(`rejects unauthenticated ${prefix} messages`, async () => {
      expect((await post(`/api/mcp/${prefix}/A/messages`)).status).toBe(401);
    });
  }
  it.each(["?k=wrong", "?k=", "?k=secret-A&k=wrong"])(
    "rejects invalid tunnel credential %s",
    async (query) => {
      expect((await post(`/api/mcp/adapter-http/A${query}`)).status).toBe(401);
    },
  );
  it("binds a tunnel credential to its exact server and route", async () => {
    for (const path of ["adapter-http/B", "adapter-http/a", "manager-http/A"]) {
      expect((await post(`/api/mcp/${path}?k=secret-A`)).status).toBe(401);
    }
    expect((await post("/api/mcp/adapter-http/A?k=secret-A")).status).toBe(200);
  });
  it("blocks cross-server tools without invoking the target", async () => {
    const res = await post("/api/mcp/adapter-http/A?k=secret-A", {
      ...rpc,
      method: "tools/call",
      params: { name: "B:write_file", arguments: {} },
    } as any);
    expect((await res.json()).error.code).toBe(-32602);
    expect(manager.executeTool).not.toHaveBeenCalled();
  });
  async function open(query: string, headers: Record<string, string> = {}) {
    const res = await app.request(`/api/mcp/adapter-http/A${query}`, {
      headers,
    });
    expect(res.status).toBe(200);
    const reader = res.body!.getReader();
    let text = "";
    while (!text.includes("sessionId="))
      text += new TextDecoder().decode((await reader.read()).value);
    const endpoint = JSON.parse(text.match(/data: (\{"url":.*\})/)![1])
      .url as string;
    return { reader, endpoint };
  }
  it.each(["tunnel", "query", "header"])(
    "completes the SSE exchange with %s authentication",
    async (kind) => {
      const headers =
        kind === "header" ? { "X-MCP-Session-Auth": `Bearer ${token}` } : {};
      const { reader, endpoint } = await open(
        kind === "tunnel"
          ? "?k=secret-A"
          : kind === "query"
          ? `?_token=${token}`
          : "",
        headers,
      );
      try {
        const url = new URL(endpoint);
        expect(url.searchParams.get(kind === "tunnel" ? "k" : "_token")).toBe(
          kind === "tunnel" ? "secret-A" : kind === "query" ? token : null,
        );
        expect((await post(endpoint, rpc, headers)).status).toBe(202);
      } finally {
        await reader.cancel();
      }
    },
  );
  it("rejects cross-caller explicit sessions and fallback", async () => {
    const local = await open(`?_token=${token}`);
    const tunnel = await open("?k=secret-A");
    try {
      const toLocal = new URL(local.endpoint);
      toLocal.searchParams.delete("_token");
      toLocal.searchParams.set("k", "secret-A");
      const toTunnel = new URL(tunnel.endpoint);
      toTunnel.searchParams.delete("k");
      toTunnel.searchParams.set("_token", token);
      expect((await post(toLocal.href)).status).toBe(400);
      expect((await post(toTunnel.href)).status).toBe(400);
      await tunnel.reader.cancel();
      expect(
        (await post("/api/mcp/adapter-http/A/messages?k=secret-A")).status,
      ).toBe(400);
    } finally {
      await local.reader.cancel();
    }
  });
});
