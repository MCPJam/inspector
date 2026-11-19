import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Hono } from "hono";
import {
  createMockMcpClientManager,
  createTestApp,
  type MockMCPClientManager,
} from "./helpers/index.js";

const mocks = vi.hoisted(() => ({
  recordConnectInspection: vi.fn(async (..._args: unknown[]) => ({ canvas: true })),
  resolveServerCanvasRollout: vi.fn(async (..._args: unknown[]) => true),
}));

vi.mock("../../../services/server-canvas/connect-hook.js", () => ({
  recordConnectInspection: mocks.recordConnectInspection,
}));
vi.mock("../../../utils/server-canvas-rollout.js", () => ({
  resolveServerCanvasRollout: mocks.resolveServerCanvasRollout,
}));

const SUMMARY = {
  completedAt: 1_700_000_000_000,
  issuer: "https://auth.example.test",
  resourceIndicatorSent: true,
  scopesRequested: ["read"],
  scopesGranted: ["read"],
  issReturned: true,
  issValidated: true,
  refreshTokenIssued: true,
};

describe("POST /api/mcp/connect: server canvas", () => {
  let manager: MockMCPClientManager;
  let app: Hono;
  const originalConvexUrl = process.env.CONVEX_HTTP_URL;

  beforeEach(() => {
    vi.clearAllMocks();
    process.env.CONVEX_HTTP_URL = "https://convex.example";
    manager = createMockMcpClientManager();
    app = createTestApp(manager, "connect");
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response(
            JSON.stringify({
              results: {
                srv_test: {
                  ok: true,
                  role: "owner",
                  accessLevel: "project_member",
                  permissions: { chatOnly: false },
                  serverConfig: {
                    transportType: "http",
                    url: "http://localhost:3000/mcp",
                  },
                  oauthAccessToken: "oauth-token-123",
                  oauthCredentialId: "cred_1",
                },
              },
            }),
            { status: 200, headers: { "Content-Type": "application/json" } },
          ),
      ),
    );
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    if (originalConvexUrl === undefined) delete process.env.CONVEX_HTTP_URL;
    else process.env.CONVEX_HTTP_URL = originalConvexUrl;
  });

  async function connect(extra: Record<string, unknown>) {
    return app.request("/api/mcp/connect", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: "Bearer member-token",
      },
      body: JSON.stringify({
        projectId: "proj_test",
        serverId: "srv_test",
        serverName: "test-server",
        ...extra,
      }),
    });
  }

  it("hands the capture the rollout, account and validated OAuth summary", async () => {
    const res = await connect({
      oauthFlowSummary: { ...SUMMARY, accessToken: "SECRET_ACCESS" },
    });

    expect(res.status).toBe(200);
    expect(mocks.resolveServerCanvasRollout).toHaveBeenCalledWith("member-token");
    const [input] = mocks.recordConnectInspection.mock.calls[0] as [
      Record<string, unknown>,
    ];
    expect(input).toMatchObject({
      hosted: false,
      projectId: "proj_test",
      serverId: "srv_test",
      managerKey: "test-server",
      convexBearer: "member-token",
      serverUrl: "http://localhost:3000/mcp",
      accountKey: "cred_1",
      oauthFlow: SUMMARY,
      logPrefix: "connect-inspection",
    });
    expect(input.oauthFlow).not.toHaveProperty("accessToken");
    await expect(input.canvasRollout).resolves.toBe(true);
  });

  it("drops an invalid summary without failing the connect", async () => {
    const res = await connect({ oauthFlowSummary: { refreshTokenIssued: "x" } });

    expect(res.status).toBe(200);
    const [input] = mocks.recordConnectInspection.mock.calls[0] as [
      Record<string, unknown>,
    ];
    expect(input.oauthFlow).toBeUndefined();
  });
});
