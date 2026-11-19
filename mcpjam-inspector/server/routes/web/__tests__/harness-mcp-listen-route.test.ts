/**
 * `subscriptions/listen` through the hosted harness MCP proxy, with the relay
 * switched on: the harness gets the upstream's acknowledgment as an event
 * stream, and its `notifications/cancelled` closes the upstream listen.
 */
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { Hono } from "hono";

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

const post = (body: unknown) =>
  app.request("/api/web/harness-mcp/srv-a", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "X-MCPJam-Proxy-Token": token(),
    },
    body: JSON.stringify(body),
  });

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
    expect((await reader.read()).done).toBe(true);
    expect(upstream.handle.close).toHaveBeenCalled();
    await vi.waitFor(() =>
      expect(upstream.manager.disconnectAllServers).toHaveBeenCalled(),
    );
  });
});
