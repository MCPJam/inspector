import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Hosted connects keep the user's OAuth login in Convex and rarely leave a
 * token in the page, so these routes must take the saved login that
 * `authorizeServer` hands back — the browser's token alone left protocol,
 * apps and tasks unauthenticated on every OAuth server. A token in the request
 * body is never used, so it cannot get past a login the backend withheld on
 * purpose. The OAuth suite is the
 * exception: it grades the server from an unauthenticated request and runs its
 * own fresh authorization, so it must never be handed a login.
 */

const runProtocolConformanceMock = vi.hoisted(() => vi.fn());
const runAppsConformanceMock = vi.hoisted(() => vi.fn());
const runTasksConformanceMock = vi.hoisted(() => vi.fn());
const startOAuthConformanceMock = vi.hoisted(() => vi.fn());
const authorizeServerMock = vi.hoisted(() => vi.fn());
const toHttpConfigMock = vi.hoisted(() => vi.fn());

vi.mock("../auth.js", async () => {
  const { z } = await import("zod");
  return {
    handleRoute: async (c: any, handler: () => Promise<any>) => {
      try {
        return c.json(await handler(), 200);
      } catch (error: any) {
        return c.json(
          { code: error?.code ?? "INTERNAL_ERROR", message: error?.message },
          error?.status ?? 500,
        );
      }
    },
    projectServerSchema: z.object({}).passthrough(),
    authorizeServer: authorizeServerMock,
    toHttpConfig: toHttpConfigMock,
  };
});

vi.mock("../../shared/conformance", () => ({
  runProtocolConformance: runProtocolConformanceMock,
  runAppsConformance: runAppsConformanceMock,
  runTasksConformance: runTasksConformanceMock,
  startOAuthConformance: startOAuthConformanceMock,
  completeOAuthConformance: vi.fn(),
  submitOAuthConformanceCode: vi.fn(),
  UnsupportedTransportError: class extends Error {},
  OAuthConformanceSessionNotFoundError: class extends Error {},
  OAuthConformanceSessionFailedError: class extends Error {},
}));

async function post(path: string, body: Record<string, unknown>) {
  const { default: conformanceWeb } = await import("../conformance.js");
  return conformanceWeb.request(path, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: "Bearer test-token",
    },
    body: JSON.stringify(body),
  });
}

function authorizedServer(savedLogin?: string) {
  return {
    serverConfig: {
      transportType: "http",
      url: "https://mcp.example.test/mcp",
      headers: { "X-Api-Key": "saved-header" },
    },
    ...(savedLogin ? { oauthAccessToken: savedLogin } : {}),
  };
}

beforeEach(async () => {
  vi.clearAllMocks();
  // `mcp.example.test` never resolves. Pin the egress guard's DNS so these
  // tests reach the mocked runners in hosted mode too.
  const guard = await import("../../../utils/hosted-egress-guard.js");
  guard.setEgressHostResolverForTests(async () => ["93.184.216.34"]);
  authorizeServerMock.mockResolvedValue(authorizedServer("saved-token"));
  toHttpConfigMock.mockImplementation((_auth: unknown, timeoutMs: number) => ({
    url: "https://mcp.example.test/mcp",
    requestInit: { headers: {} },
    timeout: timeoutMs,
  }));
  runProtocolConformanceMock.mockResolvedValue({
    result: { outcome: "passed", checks: [] },
  });
  runAppsConformanceMock.mockResolvedValue({
    result: { outcome: "passed", checks: [] },
  });
  runTasksConformanceMock.mockResolvedValue({
    result: { outcome: "passed", checks: [] },
  });
  startOAuthConformanceMock.mockResolvedValue({
    phase: "complete",
    result: { passed: true, steps: [] },
  });
});

afterEach(async () => {
  const guard = await import("../../../utils/hosted-egress-guard.js");
  guard.setEgressHostResolverForTests(null);
});

describe("hosted conformance — saved login", () => {
  it("protocol sends the saved login when the browser sent none", async () => {
    const res = await post("/protocol", { projectId: "p1", serverId: "s1" });

    expect(res.status).toBe(200);
    expect(runProtocolConformanceMock.mock.calls[0][0].customHeaders).toEqual({
      "X-Api-Key": "saved-header",
      Authorization: "Bearer saved-token",
    });
  });

  it("protocol prefers the saved login over the browser's", async () => {
    await post("/protocol", {
      projectId: "p1",
      serverId: "s1",
      oauthAccessToken: "browser-token",
    });

    expect(
      runProtocolConformanceMock.mock.calls[0][0].customHeaders.Authorization,
    ).toBe("Bearer saved-token");
  });

  it("protocol ignores the browser's login when none is saved", async () => {
    authorizeServerMock.mockResolvedValue(authorizedServer());

    await post("/protocol", {
      projectId: "p1",
      serverId: "s1",
      oauthAccessToken: "browser-token",
    });

    expect(
      runProtocolConformanceMock.mock.calls[0][0].customHeaders.Authorization,
    ).toBeUndefined();
  });

  it("protocol replaces a saved authorization header in any case", async () => {
    authorizeServerMock.mockResolvedValue({
      ...authorizedServer("saved-token"),
      serverConfig: {
        transportType: "http",
        url: "https://mcp.example.test/mcp",
        headers: { authorization: "Bearer stale" },
      },
    });

    await post("/protocol", { projectId: "p1", serverId: "s1" });

    expect(runProtocolConformanceMock.mock.calls[0][0].customHeaders).toEqual({
      Authorization: "Bearer saved-token",
    });
  });

  it.each(["/apps", "/tasks"])("%s connects with the saved login", async (path) => {
    const res = await post(path, {
      projectId: "p1",
      serverId: "s1",
      oauthAccessToken: "browser-token",
    });

    expect(res.status).toBe(200);
    expect(toHttpConfigMock.mock.calls[0][2]).toBe("saved-token");
  });

  it.each(["/apps", "/tasks"])(
    "%s ignores the browser's login when none is saved",
    async (path) => {
      authorizeServerMock.mockResolvedValue(authorizedServer());

      const res = await post(path, {
        projectId: "p1",
        serverId: "s1",
        oauthAccessToken: "browser-token",
      });

      expect(res.status).toBe(200);
      expect(toHttpConfigMock.mock.calls[0][2]).toBeUndefined();
    },
  );

  it("the OAuth suite gets no login, saved or sent", async () => {
    const res = await post("/oauth/start", {
      projectId: "p1",
      serverId: "s1",
      oauthAccessToken: "browser-token",
      callbackOrigin: "https://app.example.test",
    });

    expect(res.status).toBe(200);
    expect(
      startOAuthConformanceMock.mock.calls[0][0].defaultCustomHeaders,
    ).toEqual({ "X-Api-Key": "saved-header" });
  });
});
