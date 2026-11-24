/**
 * `diagnose_server` on a mock: the doctor authorizes the mock's id, dials it in
 * process as the person who asked, and judges it as the server it is. Nothing
 * goes to the placeholder address, which resolves nowhere.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../../../utils/mcp-backpressure.js", () => ({
  hostedMcpBackpressureFetch: ({ fetch }: { fetch: typeof globalThis.fetch }) => fetch,
}));

import { registerMockInProcessHandler } from "../../../services/mock/registry.js";
import { inProcessMockHandler } from "../../../services/mock/route.js";
import { mockConnectionPool } from "../../../services/mock/connection.js";
import { resolvedMock, stubRealServer } from "../../../services/mock/__tests__/helpers.js";
import { runHostedDoctor } from "../servers.js";

const NOW = Date.now();

function context() {
  const vars: Record<string, unknown> = { authMethod: "authkit_jwt", workosUserId: "ann" };
  return {
    req: { header: (name: string) => (name.toLowerCase() === "authorization" ? "Bearer ann-bearer" : undefined) },
    get: (key: string) => vars[key],
    set: (key: string, value: unknown) => {
      vars[key] = value;
    },
    var: vars,
  };
}

let networkCalls: string[];

beforeEach(() => {
  vi.stubEnv("CONVEX_HTTP_URL", "https://convex.test");
  networkCalls = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: string | URL | Request) => {
      networkCalls.push(String(input instanceof Request ? input.url : input));
      return Response.json({
        authorized: true,
        role: "member",
        accessLevel: "project_member",
        permissions: { chatOnly: false },
        oauthAccessToken: "doctor-grant-token-aaaa",
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

describe("runHostedDoctor on a mock", () => {
  it("connects through the route, lists the mock's own tools, and dials no address", async () => {
    const stub = stubRealServer();
    registerMockInProcessHandler(
      inProcessMockHandler({ open: stub.open, resolve: async () => resolvedMock({ projectId: "proj1" }) }),
    );
    const result = await runHostedDoctor(
      context(),
      { projectId: "proj1", serverId: "mock1" },
      15_000,
    );
    expect(result.connection.status).toBe("connected");
    expect(result.tools.find((tool: { name: string }) => tool.name === "echo")?.description).toBe("MOCKED echo");
    // Only MCPJam's own authorize call left this process; the placeholder was never dialed.
    expect(networkCalls.every((url) => url.startsWith("https://convex.test/"))).toBe(true);
    expect(JSON.stringify(result)).not.toContain("doctor-grant-token-aaaa");
  });
});
