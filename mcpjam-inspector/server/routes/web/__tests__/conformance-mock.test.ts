/**
 * Conformance on a mock: the routes authorize the mock's id, hand the suites
 * the in-process dispatch as their transport, and judge no address, because
 * the placeholder resolves nowhere. The suites then test the mock as the real
 * server it is.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { runProtocolMock, runAppsMock, egressMock } = vi.hoisted(() => ({
  runProtocolMock: vi.fn(),
  runAppsMock: vi.fn(),
  egressMock: vi.fn(),
}));

vi.mock("../../../utils/mcp-backpressure.js", () => ({
  hostedMcpBackpressureFetch: ({ fetch }: { fetch: typeof globalThis.fetch }) => fetch,
}));
vi.mock("../../shared/conformance", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../shared/conformance")>()),
  runProtocolConformance: runProtocolMock,
  runAppsConformance: runAppsMock,
}));
vi.mock("../../../utils/hosted-egress-guard.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../../utils/hosted-egress-guard.js")>()),
  assertAllowedHostedTargetUrl: egressMock,
}));

import { registerMockInProcessHandler } from "../../../services/mock/registry.js";
import { inProcessMockHandler } from "../../../services/mock/route.js";
import { mockConnectionPool } from "../../../services/mock/connection.js";
import { resolvedMock, stubRealServer } from "../../../services/mock/__tests__/helpers.js";
import conformanceWeb from "../conformance.js";

const NOW = Date.now();
let networkCalls: string[];
let authorizeCalls: number;

const INITIALIZE = {
  jsonrpc: "2.0",
  id: 1,
  method: "initialize",
  params: {
    protocolVersion: "2025-06-18",
    capabilities: {},
    clientInfo: { name: "conformance-test", version: "1" },
  },
};

function post(path: string, body: Record<string, unknown> = {}) {
  return conformanceWeb.request(path, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: "Bearer ann-bearer" },
    body: JSON.stringify({ projectId: "proj1", serverId: "mock1", ...body }),
  });
}

beforeEach(() => {
  vi.stubEnv("CONVEX_HTTP_URL", "https://convex.test");
  networkCalls = [];
  authorizeCalls = 0;
  egressMock.mockReset();
  egressMock.mockRejectedValue(new Error("the placeholder must not be judged"));
  runProtocolMock.mockReset().mockResolvedValue({ result: { outcome: "passed", checks: [] } });
  runAppsMock.mockReset().mockResolvedValue({ result: { outcome: "passed", checks: [] } });
  const stub = stubRealServer();
  registerMockInProcessHandler(
    inProcessMockHandler({ open: stub.open, resolve: async () => resolvedMock({ projectId: "proj1" }) }),
  );
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: string | URL | Request) => {
      networkCalls.push(String(input instanceof Request ? input.url : input));
      authorizeCalls += 1;
      return Response.json({
        authorized: true,
        role: "member",
        accessLevel: "project_member",
        permissions: { chatOnly: false },
        oauthAccessToken: "conformance-grant-aaaa",
        serverConfig: {
          name: "Echo mock",
          transportType: "http",
          url: "https://mock.mcpjam.invalid/mock1",
          headers: {},
          mock: { mockId: "mock1", version: 2, contentHash: "h".repeat(64), grantExpiresAt: NOW + 3_600_000 },
        },
      });
    }),
  );
});
afterEach(async () => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  await mockConnectionPool.clear();
});

describe("conformance routes on a mock", () => {
  it("connection-check reaches the mock's route in process and dials no address", async () => {
    const response = await post("/connection-check", { protocolVersion: "auto" });
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ status: "ready" });
    expect(networkCalls.every((url) => url.startsWith("https://convex.test/"))).toBe(true);
    expect(egressMock).not.toHaveBeenCalled();
  });

  it("protocol runs with the mock's dispatch as its transport", async () => {
    const response = await post("/protocol");
    expect(response.status).toBe(200);
    const input = runProtocolMock.mock.calls[0][0];
    expect(input.serverUrl).toBe("https://mock.mcpjam.invalid/mock1");
    expect(input.customHeaders).toBeUndefined();
    const answer = await input.baseFetch(input.serverUrl, {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json, text/event-stream" },
      body: JSON.stringify(INITIALIZE),
    });
    // The route answered in this process; the only network call is MCPJam's authorize.
    expect(answer.status).toBe(200);
    expect(await answer.text()).toContain("serverInfo");
    expect(networkCalls).toHaveLength(authorizeCalls);
    expect(egressMock).not.toHaveBeenCalled();
  });

  it("apps hands the suite the same dispatch", async () => {
    const response = await post("/apps");
    expect(response.status).toBe(200);
    const config = runAppsMock.mock.calls[0][0];
    expect(config.url).toBe("https://mock.mcpjam.invalid/mock1");
    expect(typeof config.baseFetch).toBe("function");
    expect(egressMock).not.toHaveBeenCalled();
  });

  it("oauth start says a mock has no sign-in to grade", async () => {
    const response = await post("/oauth/start", { callbackOrigin: "https://app.test" });
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({
      message: expect.stringContaining("mock server, which has no sign-in"),
    });
  });
});
