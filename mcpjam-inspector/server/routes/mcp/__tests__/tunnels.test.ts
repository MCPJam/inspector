import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Hono } from "hono";

const grants = vi.hoisted(() => ({
  fetchRelayGrant: vi.fn(),
  fetchRotationGrant: vi.fn(),
  reportTunnelClosure: vi.fn(),
}));
vi.mock("../../../services/tunnel-grants", () => grants);

import { createMockMcpClientManager, createTestApp } from "./helpers/index.js";
import { tunnelManager } from "../../../services/tunnel-manager.js";
import { requestLogContextMiddleware } from "../../../middleware/request-log-context.js";
import { recordDeliveredAccountKind } from "../../../utils/delivered-oauth-credential.js";

const GRANT = {
  slug: "slug0001",
  url: "https://slug0001.tunnels.mcpjam.com/api/mcp/adapter-http/Linear?k=secret",
  connectToken: "connect",
  relayWsUrl: "wss://relay.example/connect",
  secretVersion: 1,
};

describe("POST /api/mcp/tunnels/create/:serverId", () => {
  const manager = createMockMcpClientManager();
  let app: Hono;

  beforeEach(() => {
    grants.fetchRelayGrant.mockResolvedValue(GRANT);
    grants.fetchRotationGrant.mockResolvedValue(GRANT);
    vi.spyOn(tunnelManager, "getServerTunnelUrl").mockReturnValue(null);
    vi.spyOn(tunnelManager, "createTunnel").mockResolvedValue(
      "https://slug0001.tunnels.mcpjam.com",
    );
    vi.spyOn(tunnelManager, "rotateTunnel").mockResolvedValue(
      "https://slug0001.tunnels.mcpjam.com",
    );
    // The route logs through the request's log context, as in the real app.
    app = new Hono();
    app.use("*", requestLogContextMiddleware);
    app.route("/", createTestApp(manager, "tunnels"));
  });

  afterEach(() => {
    vi.restoreAllMocks();
    grants.fetchRelayGrant.mockReset();
    grants.fetchRotationGrant.mockReset();
  });

  const connectedWith = (kind: "shared" | "uploaded" | undefined) =>
    recordDeliveredAccountKind(manager, "Linear", {
      config: {
        url: "https://mcp.example.com/mcp",
        credentialSource: "mcpjam-backend",
      },
      authorizeResult: { oauthAccountKind: kind },
    });

  it.each(["shared", "uploaded"] as const)(
    "refuses to publish a connection signed in with a %s account",
    async (kind) => {
      connectedWith(kind);
      for (const path of ["create", "rotate"]) {
        const res = await app.request(`/api/mcp/tunnels/${path}/Linear`, {
          method: "POST",
        });
        expect(res.status).toBe(403);
        expect((await res.json()).error).toMatch(
          /so you can't create a tunnel for it\. Tunnels can share only a server you signed in to yourself/,
        );
      }
      expect(grants.fetchRelayGrant).not.toHaveBeenCalled();
      expect(grants.fetchRotationGrant).not.toHaveBeenCalled();
      expect(tunnelManager.createTunnel).not.toHaveBeenCalled();
    },
  );

  it("refuses a differently cased name that dispatch would route to the same connection", async () => {
    connectedWith("shared");
    const listServers = vi
      .spyOn(manager, "listServers")
      .mockReturnValue(["Linear"]);
    const res = await app.request("/api/mcp/tunnels/create/linear", {
      method: "POST",
    });
    expect(res.status).toBe(403);
    expect(tunnelManager.createTunnel).not.toHaveBeenCalled();
    listServers.mockRestore();
  });

  it("publishes a connection on the person's own sign-in", async () => {
    connectedWith(undefined);
    const res = await app.request("/api/mcp/tunnels/create/Linear", {
      method: "POST",
    });
    expect(res.status).toBe(200);
    expect((await res.json()).url).toBe(GRANT.url);
    expect(tunnelManager.createTunnel).toHaveBeenCalledOnce();
  });
});
