import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";

/**
 * The hosted conformance routes take a target URL from the request side and
 * dial it from our cloud backend. Two inputs reach the dialer — the URL Convex
 * resolved for the authorized server row, and `oauthProfile.serverUrl`, which
 * the OAuth suite lets a caller supply outright — and neither was checked
 * before. Authorizing the server row proves who is asking, not where we are
 * about to connect.
 *
 * Local/desktop mode must keep dialing localhost: that is the product.
 */

const runProtocolConformanceMock = vi.hoisted(() => vi.fn());
const startOAuthConformanceMock = vi.hoisted(() => vi.fn());
const authorizeServerMock = vi.hoisted(() => vi.fn());
const serverUrlRef = vi.hoisted(() => ({
  current: "https://mcp.example.test/mcp",
}));

vi.mock("../auth.js", async () => {
  const { z } = await import("zod");
  return {
    handleRoute: async (c: any, handler: () => Promise<any>) => {
      try {
        return c.json(await handler(), 200);
      } catch (error: any) {
        return c.json(
          { code: error?.code ?? "INTERNAL_ERROR", message: error?.message },
          error?.status ?? 500
        );
      }
    },
    projectServerSchema: z.object({}).passthrough(),
    authorizeServer: authorizeServerMock,
    toHttpConfig: (_auth: unknown, timeoutMs: number) => ({
      url: serverUrlRef.current,
      requestInit: { headers: {} },
      timeout: timeoutMs,
    }),
  };
});

vi.mock("../../shared/conformance", () => ({
  runProtocolConformance: runProtocolConformanceMock,
  startOAuthConformance: startOAuthConformanceMock,
  runTasksConformance: vi.fn(),
  runAppsConformance: vi.fn(),
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

/**
 * `HOSTED_MODE` is read from the environment when `server/config` is first
 * imported, so each mode needs a fresh module registry.
 */
async function withHostedMode<T>(hosted: boolean, run: () => Promise<T>) {
  const previous = process.env.VITE_MCPJAM_HOSTED_MODE;
  process.env.VITE_MCPJAM_HOSTED_MODE = hosted ? "true" : "false";
  vi.resetModules();
  try {
    if (hosted) {
      // Fabricated test hostnames resolve nowhere, and the guard fails closed
      // on an unresolvable host. Answer for them so these cases exercise the
      // address rules rather than the lookup branch.
      const guard = await import("../../../utils/hosted-egress-guard.js");
      guard.setEgressHostResolverForTests(async () => ["93.184.216.34"]);
    }
    return await run();
  } finally {
    if (previous === undefined) delete process.env.VITE_MCPJAM_HOSTED_MODE;
    else process.env.VITE_MCPJAM_HOSTED_MODE = previous;
    vi.resetModules();
  }
}

beforeEach(() => {
  vi.clearAllMocks();
  serverUrlRef.current = "https://mcp.example.test/mcp";
  authorizeServerMock.mockImplementation(async () => ({
    serverConfig: { transportType: "http", url: serverUrlRef.current },
  }));
  runProtocolConformanceMock.mockResolvedValue({
    result: { outcome: "passed", checks: [] },
  });
  startOAuthConformanceMock.mockResolvedValue({ phase: "complete" });
});

afterEach(() => {
  vi.resetModules();
});

describe("hosted conformance — resolved server URL", () => {
  it("rejects a private target in hosted mode, before any run starts", async () => {
    await withHostedMode(true, async () => {
      for (const url of [
        "http://169.254.169.254/mcp",
        "http://127.0.0.1:3000/mcp",
        "http://10.0.0.5/mcp",
        "http://[::ffff:a9fe:a9fe]/mcp",
      ]) {
        serverUrlRef.current = url;
        const res = await post("/protocol", {
          projectId: "p1",
          serverId: "s1",
        });
        expect(res.status).toBe(400);
        const body = (await res.json()) as { code: string; message: string };
        expect(body.code).toBe("VALIDATION_ERROR");
        expect(body.message).toMatch(/private or internal address/);
      }
      // Refused means refused — the suite never ran.
      expect(runProtocolConformanceMock).not.toHaveBeenCalled();
    });
  });

  it("allows a public target in hosted mode", async () => {
    await withHostedMode(true, async () => {
      const res = await post("/protocol", { projectId: "p1", serverId: "s1" });
      expect(res.status).toBe(200);
      expect(runProtocolConformanceMock).toHaveBeenCalledTimes(1);
    });
  });

  it("allows localhost in local mode — testing a local server is the product", async () => {
    await withHostedMode(false, async () => {
      serverUrlRef.current = "http://localhost:3000/mcp";
      const res = await post("/protocol", { projectId: "p1", serverId: "s1" });
      expect(res.status).toBe(200);
      expect(runProtocolConformanceMock).toHaveBeenCalledTimes(1);
    });
  });
});

describe("hosted conformance — oauthProfile.serverUrl", () => {
  const oauthBody = (serverUrl: string) => ({
    projectId: "p1",
    serverId: "s1",
    callbackOrigin: "https://app.mcpjam.com",
    oauthProfile: { serverUrl },
  });

  it("rejects a private override even though the server row is authorized", async () => {
    await withHostedMode(true, async () => {
      const res = await post(
        "/oauth/start",
        oauthBody("http://169.254.169.254/")
      );
      expect(res.status).toBe(400);
      const body = (await res.json()) as { code: string; message: string };
      expect(body.code).toBe("VALIDATION_ERROR");
      expect(body.message).toMatch(/OAuth profile server URL/);
      expect(startOAuthConformanceMock).not.toHaveBeenCalled();
    });
  });

  it("allows a public override in hosted mode", async () => {
    await withHostedMode(true, async () => {
      const res = await post(
        "/oauth/start",
        oauthBody("https://auth.example.test/")
      );
      expect(res.status).toBe(200);
      expect(startOAuthConformanceMock).toHaveBeenCalledTimes(1);
    });
  });

  it("allows a localhost override in local mode", async () => {
    await withHostedMode(false, async () => {
      const res = await post(
        "/oauth/start",
        oauthBody("http://localhost:9000/")
      );
      expect(res.status).toBe(200);
      expect(startOAuthConformanceMock).toHaveBeenCalledTimes(1);
    });
  });
});
