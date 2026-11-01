import { getManagerResourceSnapshot, setManagerResourceSnapshots } from "../../../utils/mcp-connections";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { Hono } from "hono";
const m = vi.hoisted(() => ({ order: [] as string[] }));
vi.mock("../../../routes/web/hosted-elicitation.js", async (original) => ({
  ...(await original<
    typeof import("../../../routes/web/hosted-elicitation.js")
  >()),
  resolveElicitationGate: () => ({
    effectiveClientCapabilities: undefined,
    enabled: true,
  }),
  HostedElicitationBridge: class {
    callback = vi.fn();
    async dispose() {
      m.order.push("withdraw elicitations");
    }
  },
}));
vi.mock("../../../routes/web/auth.js", async (original) => ({
  ...(await original<typeof import("../../../routes/web/auth.js")>()),
  createAuthorizedManager: async () => ({
    manager: {
      disconnectAllServers: async () => {
        m.order.push("disconnect servers");
      },
      getInitializationInfo: () => undefined,
    },
    oauthServerUrls: {},
    authenticatedUserId: "user-1",
    refusedServers: [],
  }),
}));
vi.mock("../../../utils/v1-convex-token.js", () => ({
  getConvexBearerForRequest: async () => "convex-bearer",
}));
vi.mock("../../../utils/connection-profile-refresh.js", () => ({
  refreshConnectionProfiles: async () => {},
}));
vi.mock("../../xaa-mint.js", async (original) => ({
  ...(await original<typeof import("../../xaa-mint.js")>()),
  resolveXaaIssuer: () => "https://issuer.test",
}));
import { prepareManagedConnections } from "../managed-connections.js";
import { TurnResources } from "../resources.js";
import { createHostedRpcLogCollector } from "../../../routes/web/hosted-rpc-logs.js";

type Setup = Parameters<typeof prepareManagedConnections>[0]["setup"];
const setup = {
  hostedBody: {
    projectId: "project-1",
    chatSessionId: "chat-1",
    selectedServerIds: ["server-1"],
    messages: [],
  },
  body: {},
  messages: [],
  selectedServerIds: ["server-1"],
  selectedServerNames: ["Server"],
  modelDefinition: { id: "openai/gpt-5-mini", provider: "openai" },
  turnMode: "interactive",
  isHostAuthoritative: false,
  effectiveServerIds: ["server-1"],
  effectiveServerNames: ["Server"],
  resolvedExecution: {},
  turnRail: "hosted",
} as unknown as Setup;

describe("managed connection ownership", () => {
  beforeEach(() => {
    m.order = [];
  });
  it("withdraws pending elicitations before it disconnects the turn's servers", async () => {
    const resources = new TurnResources((error) => {
      throw error;
    });
    const app = new Hono();
    app.post("/", async (c) => {
      const prepared = await prepareManagedConnections({
        c,
        rawBody: {},
        bearerToken: "bearer",
        rpcCollector: createHostedRpcLogCollector({}),
        resources,
        setup: {...setup, hostRuntimeConfig: {hostConfigId: "saved-host-config", hostId: "host", hostStyle: "claude", modelId: "anthropic/claude-haiku-4.5", systemPrompt: "", temperature: 0, requireToolApproval: false}},
        onOAuthServerUrls: () => {},
      });
      setManagerResourceSnapshots(prepared.manager, new Map([["server-1", {serverUpdatedAt: 1, credentialAuthorizedAt: null}]]));
      expect(getManagerResourceSnapshot(prepared.manager, "server-1")?.hostConfigId).toBe("saved-host-config");
      return c.json({});
    });
    expect((await app.request("/", { method: "POST" })).status).toBe(200);
    await resources.dispose();
    expect(m.order).toEqual(["withdraw elicitations", "disconnect servers"]);
  });
});
