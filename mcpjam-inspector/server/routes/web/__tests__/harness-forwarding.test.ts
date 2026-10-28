import { createHash } from "node:crypto";
import { Hono } from "hono";
import { afterEach, expect, it, vi } from "vitest";
import { handleNativeForwarding } from "../harness-forwarding.js";

const state = vi.hoisted(() => ({
  expiresAt: Date.now() + 30 * 60_000,
  gate: vi.fn(),
  disconnect: vi.fn(),
}));
const owner = {
  kind: "chat",
  userId: "user",
  serverId: "server",
  harnessSessionId: "lane",
};
vi.mock("../../../utils/harness/harness-proxy-policy-seal.js", () => ({
  unsealHarnessProxyToken: () => ({
    token: JSON.stringify({ owner, turnId: "turn" }),
  }),
}));
vi.mock(
  "../../../utils/harness/forwarding/execution-control.js",
  async (original) => ({
    ...(await original<
      typeof import("../../../utils/harness/forwarding/execution-control.js")
    >()),
    createExecutionControl: () => ({
      authorize: async () => ({
        userId: "user",
        externalId: "external",
        projectId: "project",
        organizationId: "internal",
        expiresAt: state.expiresAt,
      }),
    }),
  }),
);
vi.mock("../auth.js", () => ({
  createAuthorizedManager: async () => ({
    authenticatedUserId: "user",
    authorizedServerConfigs: {
      server: { url: "https://fixture.example/mcp", baseFetch: fetch },
    },
    manager: { disconnectAllServers: state.disconnect },
  }),
}));
vi.mock("../../../utils/harness/forwarding/execution-gate.js", () => ({
  executeForwardedOperation: state.gate,
}));

afterEach(() => vi.unstubAllEnvs());

it("passes the authorized lease deadline to the gate without a five-minute cap", async () => {
  vi.stubEnv("HARNESS_NATIVE_FORWARDING", "true");
  vi.stubEnv("HARNESS_FORWARDING_ORGANIZATION_IDS", "internal");
  state.gate.mockResolvedValue(new Response("ok"));
  const app = new Hono();
  app.post("/:serverId", handleNativeForwarding);
  const header =
    "x-mcpjam-forwarding-" +
    createHash("sha256")
      .update(JSON.stringify(["server", "server:server"]))
      .digest("hex")
      .slice(0, 40);
  const response = await app.request("/server", {
    method: "POST",
    headers: { "content-type": "application/json", [header]: "test-grant" },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      params: { name: "read" },
    }),
  });
  expect(response.status).toBe(200);
  expect(state.gate).toHaveBeenCalledWith(
    expect.objectContaining({
      operation: expect.objectContaining({ expiresAt: state.expiresAt }),
    }),
  );
  expect(state.disconnect).toHaveBeenCalledOnce();
});
