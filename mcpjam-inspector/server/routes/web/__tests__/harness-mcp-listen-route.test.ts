/**
 * `subscriptions/listen` through the hosted harness MCP proxy, with the relay
 * switched on: the harness gets the upstream's acknowledgment as an event
 * stream, and its `notifications/cancelled` closes the upstream listen. The
 * same switch has the handshake answered from the server's real connection.
 */
import http from "node:http";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { Hono } from "hono";
import { createMcpHandler, McpServer } from "@modelcontextprotocol/server";
import { toNodeHandler } from "@modelcontextprotocol/node";
import { MCPClientManager } from "@mcpjam/sdk";

const { upstream } = vi.hoisted(() => {
  let settle: (cause: "local" | "graceful" | "remote") => void = () => {};
  const handle = {
    honoredFilter: { toolsListChanged: true },
    close: vi.fn(async () => settle("local")),
    closed: new Promise<"local" | "graceful" | "remote">((resolve) => {
      settle = resolve;
    }),
  };
  const manager = {
    getManagedClient: () => ({ listen: vi.fn(async () => handle) }),
    ensureManagedClient: async () => ({ listen: vi.fn(async () => handle) }),
    addNotificationHandler: vi.fn(),
    removeNotificationHandler: vi.fn(),
    disconnectAllServers: vi.fn(async () => undefined),
  };
  return { upstream: { handle, manager } };
});

vi.mock("../auth", () => ({
  createAuthorizedManager: vi
    .fn()
    .mockResolvedValue({ manager: upstream.manager }),
  withManager: async (mp: Promise<any>, fn: (m: any) => Promise<any>) => {
    const r = await mp;
    return fn(r.manager ?? r);
  },
}));

import { harnessMcp } from "../harness-mcp.js";
import { createAuthorizedManager } from "../auth";
import { signTestProxyToken } from "../../../utils/harness/__tests__/sign-test-token.js";

beforeAll(() => {
  process.env.COMPUTERS_TERMINAL_TOKEN_SECRET =
    "test-harness-proxy-secret-32-chars";
});

afterEach(() => {
  vi.unstubAllEnvs();
});

const app = new Hono();
app.route("/api/web/harness-mcp", harnessMcp);

const token = () =>
  signTestProxyToken({
    serverId: "srv-a",
    projectId: "p1",
    externalId: "user_ext_1",
    orgId: "org_1",
  });

const postAs = (proxyToken: string, body: unknown) =>
  app.request("/api/web/harness-mcp/srv-a", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "X-MCPJam-Proxy-Token": proxyToken,
    },
    body: JSON.stringify(body),
  });
const post = (body: unknown) => postAs(token(), body);

/** An upstream of its own: one listen handle, closed when the relay ends it. */
function ownUpstream() {
  let settle: (cause: "local" | "graceful" | "remote") => void = () => {};
  const handle = {
    honoredFilter: { toolsListChanged: true },
    close: vi.fn(async () => settle("local")),
    closed: new Promise<"local" | "graceful" | "remote">((resolve) => {
      settle = resolve;
    }),
  };
  const listen = vi.fn(async () => handle);
  return {
    handle,
    manager: {
      getManagedClient: () => ({ listen }),
      ensureManagedClient: async () => ({ listen }),
      addNotificationHandler: vi.fn(),
      removeNotificationHandler: vi.fn(),
      disconnectAllServers: vi.fn(async () => undefined),
    },
  };
}

describe("subscriptions/listen with the relay on", () => {
  it("streams the upstream acknowledgment, and the harness's cancel closes the upstream listen", async () => {
    vi.stubEnv("MCPJAM_HARNESS_LISTEN_RELAY", "1");
    const res = await post({
      jsonrpc: "2.0",
      id: 41,
      method: "subscriptions/listen",
      params: { notifications: { toolsListChanged: true } },
    });
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("text/event-stream");
    const reader = res.body!.getReader();
    const first = new TextDecoder().decode((await reader.read()).value);
    expect(JSON.parse(first.split("data: ")[1]!)).toEqual({
      jsonrpc: "2.0",
      method: "notifications/subscriptions/acknowledged",
      params: {
        _meta: { "io.modelcontextprotocol/subscriptionId": 41 },
        notifications: { toolsListChanged: true },
      },
    });

    const cancel = await post({
      jsonrpc: "2.0",
      method: "notifications/cancelled",
      params: { requestId: 41 },
    });
    expect(cancel.status).toBe(202);
    // The cancel ends the stream. A frame already in flight (such as the
    // closing result) may arrive first, so read to the end rather than
    // expecting the very next read to be it.
    let ended = false;
    for (let reads = 0; reads < 5 && !ended; reads++) {
      ended = (await reader.read()).done;
    }
    expect(ended).toBe(true);
    expect(upstream.handle.close).toHaveBeenCalled();
    await vi.waitFor(() =>
      expect(upstream.manager.disconnectAllServers).toHaveBeenCalled(),
    );
  });
});

describe("two runs' listens", () => {
  it("stay apart when both clients name theirs alike", async () => {
    vi.stubEnv("MCPJAM_HARNESS_LISTEN_RELAY", "1");
    const now = Math.floor(Date.now() / 1000);
    const claims = {
      serverId: "srv-a",
      projectId: "p1",
      externalId: "user_ext_1",
      orgId: "org_1",
    };
    const runs = [
      { token: signTestProxyToken(claims, { nowS: now }), up: ownUpstream() },
      { token: signTestProxyToken(claims, { nowS: now - 1 }), up: ownUpstream() },
    ];
    const listen = {
      jsonrpc: "2.0",
      id: "listen:0",
      method: "subscriptions/listen",
      params: { notifications: { toolsListChanged: true } },
    };
    const readers = [];
    for (const run of runs) {
      vi.mocked(createAuthorizedManager).mockResolvedValueOnce({
        manager: run.up.manager,
      } as never);
      const res = await postAs(run.token, listen);
      const reader = res.body!.getReader();
      await reader.read();
      readers.push(reader);
    }

    const cancel = await postAs(runs[0]!.token, {
      jsonrpc: "2.0",
      method: "notifications/cancelled",
      params: { requestId: "listen:0" },
    });
    expect(cancel.status).toBe(202);
    expect((await readers[0]!.read()).done).toBe(true);
    expect(runs[0]!.up.handle.close).toHaveBeenCalled();
    expect(runs[1]!.up.handle.close).not.toHaveBeenCalled();
    await readers[1]!.cancel();
    await vi.waitFor(() =>
      expect(runs[1]!.up.handle.close).toHaveBeenCalled(),
    );
  });
});

describe("server/discover through the proxy", () => {
  async function modernServer() {
    const handler = createMcpHandler(
      () =>
        new McpServer(
          { name: "route-fixture", version: "1" },
          { capabilities: { tools: { listChanged: true } } },
        ),
    );
    const server = http.createServer(toNodeHandler(handler));
    await new Promise<void>((resolve) =>
      server.listen(0, "127.0.0.1", resolve),
    );
    const address = server.address();
    if (!address || typeof address === "string")
      throw new Error("Missing fixture port");
    return {
      url: `http://127.0.0.1:${address.port}/mcp`,
      close: async () => {
        await handler.close();
        server.closeAllConnections();
        await new Promise<void>((resolve) => server.close(() => resolve()));
      },
    };
  }

  /**
   * The proxy's manager for one request, built when the proxy asks for it,
   * as in production: its connect queued, not awaited.
   */
  async function discoverThroughProxy() {
    const served = await modernServer();
    try {
      vi.mocked(createAuthorizedManager).mockImplementationOnce(
        async () =>
          ({
            manager: new MCPClientManager({
              "srv-a": { url: served.url, timeout: 5_000 },
            }),
          }) as never,
      );
      const res = await post({
        jsonrpc: "2.0",
        id: 3,
        method: "server/discover",
        params: {},
      });
      return await res.json();
    } finally {
      await served.close();
    }
  }

  it("answers from the server's real connection with the relay on", async () => {
    vi.stubEnv("MCPJAM_HARNESS_LISTEN_RELAY", "1");
    const reply = await discoverThroughProxy();
    expect(reply.error).toBeUndefined();
    expect(reply.result.supportedVersions).toContain("2026-07-28");
  });

  it("keeps the old answer with the relay off", async () => {
    const reply = await discoverThroughProxy();
    expect(reply.error).toMatchObject({ code: -32601 });
  });
});
