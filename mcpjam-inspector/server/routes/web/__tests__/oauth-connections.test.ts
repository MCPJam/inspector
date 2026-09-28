import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Hono } from "hono";
const mocks = vi.hoisted(() => ({
  capture: vi.fn(),
  authorize: vi.fn(),
  revoke: vi.fn(),
}));
vi.mock("../../../config.js", () => ({ HOSTED_MODE: false }));
vi.mock("../../../middleware/bearer-auth.js", () => ({
  bearerAuthMiddleware: (_c: unknown, next: () => Promise<void>) => next(),
}));
vi.mock("../../../middleware/guest-rate-limit.js", () => ({
  guestRateLimitMiddleware: (_c: unknown, next: () => Promise<void>) => next(),
}));
vi.mock("../../../utils/local-server-resolver.js", () => ({
  authorizeBatchLocal: mocks.authorize,
  toMCPServerConfig: (value: unknown) => value,
}));
vi.mock("../../../utils/mcp-connections.js", () => ({
  revokeLocalConnection: mocks.revoke,
}));
vi.mock("../auth.js", () => ({
  callerContextFromHono: vi.fn(),
  createAuthorizedManager: vi.fn(),
  withManager: vi.fn(),
}));
vi.mock("@mcpjam/sdk", () => ({
  captureOpenAIProfile: mocks.capture,
  withEphemeralClient: (
    _config: unknown,
    fn: (manager: unknown, key: string) => unknown,
  ) => fn({}, "server"),
}));
import connections from "../oauth-connections.js";

describe("OAuth connection routes", () => {
  const app = new Hono();
  app.use("*", async (c, next) => {
    c.mcpClientManager = {} as any;
    await next();
  });
  app.route("/connections", connections);
  const body = {
    projectId: "project",
    serverId: "server",
    connectionId: "account-b",
    expectedVaultObjectId: "generation-b",
  };
  const post = (op: string, value = body) =>
    app.request(`/connections${op}`, {
      method: "POST",
      headers: {
        Authorization: "Bearer caller",
        "Content-Type": "application/json",
      },
      body: JSON.stringify(value),
    });
  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubEnv("CONVEX_HTTP_URL", "https://backend.test");
    mocks.authorize.mockResolvedValue({
      results: { server: { ok: true, oauthAccessToken: "b-token" } },
    });
    mocks.capture.mockResolvedValue({ profile: { id: "B" } });
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(Response.json({ outcome: "recorded" })),
    );
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
  });
  it("authorizes only the selected account and forwards the capture generation", async () => {
    expect((await post("/profile")).status).toBe(200);
    expect(mocks.authorize.mock.calls[0][5]).toEqual({
      connectionIds: { server: "account-b" },
    });
    const [url, request] = vi.mocked(fetch).mock.calls[0];
    expect(url).toBe("https://backend.test/web/oauth/connections/profile");
    expect(JSON.parse(request!.body as string)).toEqual({
      ...body,
      profile: { id: "B" },
    });
    expect(request!.headers).toMatchObject({ Authorization: "Bearer caller" });
  });
  it("makes a failed profile call best effort without writing any identity", async () => {
    mocks.capture.mockRejectedValue(new Error("server unavailable"));
    const response = await post("/profile");
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ outcome: "unavailable" });
    expect(fetch).not.toHaveBeenCalled();
  });
  it.each(["stale", "missing", "deleted"])(
    "revokes the local runtime only after a committed delete (%s)",
    async (outcome) => {
      vi.mocked(fetch).mockResolvedValue(Response.json({ outcome }));
      await post("/delete");
      expect(mocks.revoke).toHaveBeenCalledTimes(outcome === "deleted" ? 1 : 0);
    },
  );
});
