import { beforeEach, describe, expect, it, vi } from "vitest";
import { Hono } from "hono";
import { getRequestLocal, type RequestLocalMap } from "../../../middleware/request-local.js";
import http from "node:http";
import { toNodeHandler } from "@modelcontextprotocol/node";
import { MCPClientManager } from "@mcpjam/sdk";
import { createFixtureHandler } from "../../../../../sdk/tests/support/dual-era-fixture.js";
import { buildHostConnectionPins } from "../../host-connection-pins.js";
import { retainedProfileFingerprint } from "../../../utils/harness/forwarding/retained-resources.js";
const m = vi.hoisted(() => ({
  hostedSetup: vi.fn(),
  authorize: vi.fn(),
  builtInPolicy: vi.fn(),
  ensure: vi.fn(),
  useLocalHarness: vi.fn(),
  localSkills: vi.fn(),
}));
vi.mock("../resolve-hosted-chat-setup.js", () => ({
  resolveHostedChatSetup: m.hostedSetup,
}));
vi.mock("../../../routes/web/auth.js", async (original) => ({
  ...(await original<typeof import("../../../routes/web/auth.js")>()),
  authorizeProject: m.authorize,
}));
vi.mock("../../../utils/built-in-tools/built-in-tool-policy.js", () => ({
  resolveTurnBuiltInToolIds: m.builtInPolicy,
}));
vi.mock("../../../utils/harness/local/run-resources.js", async (original) => ({
  ...(await original<
    typeof import("../../../utils/harness/local/run-resources.js")
  >()),
  shouldUseLocalHarness: m.useLocalHarness,
}));
vi.mock("../../../utils/harness/local/readiness.js", async (original) => ({
  ...(await original<
    typeof import("../../../utils/harness/local/readiness.js")
  >()),
  ensureLocalHarnessTarget: m.ensure,
}));
vi.mock("../../../utils/harness/harness-availability.js", async (original) => ({
  ...(await original<
    typeof import("../../../utils/harness/harness-availability.js")
  >()),
  checkHarnessRuntimeAvailable: () => ({ ok: true }),
  externalAccountHostModelRefusalReason: () => undefined,
}));
vi.mock("../../../utils/computers/cloud-skill-tools.js", async (original) => ({
  ...(await original<
    typeof import("../../../utils/computers/cloud-skill-tools.js")
  >()),
  listCloudRuntimeSkills: async () => [],
}));
vi.mock("../../../utils/skill-tools.js", async (original) => ({
  ...(await original<typeof import("../../../utils/skill-tools.js")>()),
  listLocalRuntimeSkills: m.localSkills,
}));
import { resolveManagedTurnSetup } from "../managed-setup.js";
import { LocalAutoApproveConsentRequiredError } from "../../../utils/harness/local/readiness.js";
import { createHostedRpcLogCollector } from "../../../routes/web/hosted-rpc-logs.js";

const baseBody = {
  projectId: "project-1",
  selectedServerIds: [],
  messages: [{ role: "user", content: "hi" }],
  model: { id: "openai/gpt-5-mini", provider: "openai", name: "GPT-5 Mini" },
};
function hostedSetup(
  mode: "interactive" | "recorded",
  hostRuntimeConfig: Record<string, unknown> = {},
) {
  return {
    mode,
    hostRuntimeConfig,
    environmentSpec: null,
    scenarioEnvironment: null,
    effectiveCapabilities: null,
    usesLiveSkills: true,
    authoritativeConnectionPolicy: mode === "recorded",
    pinsEnvironment: false,
    authoritativeCapabilities: mode === "recorded",
    toolConfiguration: null,
    toolConfigurationUnavailable: false,
    workspaceToolsBarred: false,
  };
}
async function resolveSetup(rawBody: Record<string, unknown>) {
  let setup: Awaited<ReturnType<typeof resolveManagedTurnSetup>> | undefined;
  let projectAuthorization: RequestLocalMap["authorizedProject"] | undefined;
  const app = new Hono();
  app.post("/", async (c) => {
    setup = await resolveManagedTurnSetup({
      c,
      rawBody: { ...baseBody, ...rawBody },
      bearerToken: "bearer",
      localIngress: true,
      rpcCollector: createHostedRpcLogCollector({}),
    });
    projectAuthorization = getRequestLocal(c, "authorizedProject");
    return setup.response ?? c.json({});
  });
  const response = await app.request("/", { method: "POST" });
  return { response, setup: setup!, projectAuthorization };
}

describe("managed setup local runtime policy", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    m.authorize.mockResolvedValue({
      chatEnvironments: false,
      chatPreparation: false,
    });
    m.builtInPolicy.mockResolvedValue({ ids: [], dropped: [] });
    m.useLocalHarness.mockResolvedValue(false);
    m.localSkills.mockResolvedValue([
      { ref: "machine-skill", skillId: "local:machine-skill" },
    ]);
  });

  it("retains successful project authorization only when the backend proves project access", async () => {
    m.hostedSetup.mockResolvedValue(hostedSetup("interactive"));
    m.authorize.mockResolvedValue({ organizationId: "verified-org", projectAccess: { projectRole: "editor" } });
    const authorized = await resolveSetup({});
    expect(authorized.projectAuthorization).toEqual({
      projectId: "project-1", organizationId: "verified-org", bearer: "bearer",
    });
    m.authorize.mockResolvedValue({ organizationId: "legacy-org" });
    expect((await resolveSetup({})).projectAuthorization).toBeUndefined();
  });

  it.each([true, false])("refuses read-only conversations with combined policy %s", async (combined) => {
    vi.stubEnv("CONVEX_HTTP_URL", "https://test.convex.site");
    const policy = { writable: false, requireNativeToolDiscovery: true };
    const fetchState = vi.fn(async () => Response.json(policy));
    vi.stubGlobal("fetch", fetchState);
    try {
      m.hostedSetup.mockResolvedValue(hostedSetup("interactive"));
      m.authorize.mockResolvedValue(combined ? { conversationState: policy } : {});
      const { response } = await resolveSetup({ chatSessionId: "chat" });
      expect(response.status).toBe(409);
      expect(await response.json()).toMatchObject({ code: "API_SESSION_READ_ONLY" });
      expect(fetchState).toHaveBeenCalledTimes(combined ? 0 : 1);
    } finally {
      vi.unstubAllGlobals();
      vi.unstubAllEnvs();
    }
  });

  it("checks auto-approve consent before a local Claude Code turn starts", async () => {
    m.hostedSetup.mockResolvedValue(
      hostedSetup("interactive", { harness: "claude-code" }),
    );
    m.useLocalHarness.mockResolvedValue(true);
    m.ensure.mockRejectedValue(new LocalAutoApproveConsentRequiredError());
    const { response } = await resolveSetup({ requireToolApproval: false });
    expect(m.ensure).toHaveBeenCalledWith(
      expect.objectContaining({ requireToolApproval: false }),
    );
    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({
      error: new LocalAutoApproveConsentRequiredError().message,
      status: "auto-approve-consent-required",
    });
  });

  it("gives an interactive turn this machine's skills", async () => {
    m.hostedSetup.mockResolvedValue(hostedSetup("interactive"));
    const { setup } = await resolveSetup({});
    expect(m.localSkills).toHaveBeenCalled();
    expect(setup.value?.liveProjectCapabilities?.localSkills).toEqual([
      expect.objectContaining({ ref: "machine-skill" }),
    ]);
  });

  it("never gives a recorded scenario turn this machine's skills", async () => {
    m.hostedSetup.mockResolvedValue(hostedSetup("recorded"));
    const { setup } = await resolveSetup({
      scenarioId: "scenario-1",
      accessVersion: 1,
    });
    expect(setup.value?.turnMode).toBe("recorded");
    expect(m.localSkills).not.toHaveBeenCalled();
    expect(setup.value?.liveProjectCapabilities?.localSkills ?? []).toEqual(
      [],
    );
  });
});


describe("request-scoped project access", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    m.useLocalHarness.mockResolvedValue(false);
    m.localSkills.mockResolvedValue([]);
    m.builtInPolicy.mockResolvedValue({ ids: [], dropped: [] });
  });
  it("passes the same explicit selection through authorization and uses its prepared result", async () => {
    const preparedChatTurn = { kind: "resolved", environment: {}, harness: null };
    m.authorize.mockResolvedValue({ chatPreparation: true, preparedChatTurn });
    m.hostedSetup.mockResolvedValue(hostedSetup("interactive"));
    await resolveSetup({ hostId: "host", selectedServerIds: [] });
    expect(m.authorize).toHaveBeenCalledWith(expect.anything(), "bearer", "project-1", undefined,
      expect.objectContaining({ projectId: "project-1", hostId: "host", serverOverrideIds: [] }), expect.any(AbortSignal));
    expect(m.hostedSetup).toHaveBeenCalledWith(expect.objectContaining({ preparedChatTurn }));
  });
  it("does not request combined preparation for an explicit environment", async () => {
    m.authorize.mockResolvedValue({});
    m.hostedSetup.mockResolvedValue(hostedSetup("interactive"));
    await resolveSetup({ executionTarget: { kind: "environment", environmentId: "saved" } });
    expect(m.authorize.mock.calls[0][4]).toBeUndefined();
  });
  it("passes advertised preparation support and reuses the authorized role", async () => {
    m.authorize.mockResolvedValue({
      chatEnvironments: true,
      chatPreparation: true,
      projectAccess: { projectRole: "editor" },
    });
    m.hostedSetup.mockResolvedValue(hostedSetup("interactive"));
    let access;
    m.builtInPolicy.mockImplementationOnce(async (args) => {
      access = await args.loadProjectAccess();
      return { ids: [], dropped: [] };
    });
    await resolveSetup({});
    expect(access).toEqual({ projectRole: "editor" });
    expect(m.hostedSetup).toHaveBeenLastCalledWith(
      expect.objectContaining({ prepareChatTurn: true }),
    );
    m.authorize.mockRejectedValueOnce(new Error("Membership removed"));
    await resolveSetup({});
    expect(m.authorize).toHaveBeenCalledTimes(2);
    expect(m.hostedSetup).toHaveBeenCalledTimes(1);
  });
});

describe("saved client connection policy", () => {
  const host = {
    connectionDefaults: { requestTimeout: 10_000 },
    mcpProfile: {
      mcpProtocolVersion: "2026-07-28",
      initialize: {
        clientInfo: { name: "saved-client", version: "1.0" },
        supportedProtocolVersions: ["2026-07-28", "2025-11-25"],
      },
    },
    serverConnectionOverrides: {
      server: { mcpProtocolVersion: "2025-11-25" },
    },
  };
  beforeEach(() => {
    vi.clearAllMocks();
    m.authorize.mockResolvedValue({ chatEnvironments: true });
    m.useLocalHarness.mockResolvedValue(false);
    m.localSkills.mockResolvedValue([]);
    m.builtInPolicy.mockResolvedValue({ ids: [], dropped: [] });
  });
  it.each([
    { hostId: "host" },
    { executionTarget: { kind: "environment", environmentId: "environment" } },
    { scenarioId: "scenario", accessVersion: 1 },
  ])(
    "uses saved pins instead of conflicting request pins for %j",
    async (target) => {
      m.hostedSetup.mockResolvedValue({
        ...hostedSetup(
          "scenarioId" in target ? "recorded" : "interactive",
          host,
        ),
        authoritativeConnectionPolicy: true,
      });
      const { setup } = await resolveSetup({
        ...target,
        clientInfo: { name: "different-client" },
        supportedProtocolVersions: ["2025-03-26"],
        mcpProtocolVersionsByServerId: {
          server: "2025-03-26",
          extra: "2025-03-26",
        },
      });
      const expected = buildHostConnectionPins(host, 120_000);
      expect(setup.value?.effectiveInitializePins).toEqual(
        expected.initializePins,
      );
      expect(setup.value?.mcpProtocolVersionsByServerId).toEqual(
        expected.mcpProtocolVersionsByServerId,
      );
    },
  );
  it("removes a request pin when the saved client omits it", async () => {
    m.hostedSetup.mockResolvedValue({
      ...hostedSetup("interactive", {}),
      authoritativeConnectionPolicy: true,
    });
    const { setup } = await resolveSetup({
      hostId: "host",
      clientInfo: { name: "different-client" },
      mcpProtocolVersionsByServerId: { server: "2025-03-26" },
    });
    expect(setup.value?.effectiveInitializePins).toBeUndefined();
    expect(setup.value?.mcpProtocolVersionsByServerId).toBeUndefined();
  });
  it("preserves ad-hoc connection overrides", async () => {
    m.hostedSetup.mockResolvedValue(hostedSetup("interactive", host));
    const { setup } = await resolveSetup({
      clientInfo: { name: "ad-hoc" },
      mcpProtocolVersionsByServerId: { server: "2025-03-26" },
    });
    expect(setup.value?.effectiveInitializePins).toMatchObject({
      clientInfo: { name: "ad-hoc" },
    });
    expect(setup.value?.mcpProtocolVersionsByServerId).toEqual({
      server: "2025-03-26",
    });
  });
  it("retains the saved client's conformance simulation", async () => {
    m.hostedSetup.mockResolvedValue({
      ...hostedSetup("interactive", {
        ...host,
        mcpProfile: {
          ...host.mcpProfile,
          paginationTraversal: "firstPageOnly",
          toolParamHeaderMirroring: "omit",
          mrtrSupport: "none",
        },
      }),
      authoritativeConnectionPolicy: true,
    });
    const { setup } = await resolveSetup({ hostId: "host" });
    expect(setup.value?.effectiveInitializePins).toMatchObject({
      clientInfo: { name: "saved-client", version: "1.0" },
      firstPageOnly: true,
      mirrorToolParamHeaders: false,
      supportsMrtr: false,
    });
  });
  it("matches real producing and App connection fingerprints without body pins", async () => {
    m.hostedSetup.mockResolvedValue({
      ...hostedSetup("interactive", host),
      authoritativeConnectionPolicy: true,
    });
    const { setup } = await resolveSetup({ hostId: "host" });
    const server = http.createServer(toNodeHandler(createFixtureHandler()));
    const producing = new MCPClientManager();
    const app = new MCPClientManager();
    try {
      await new Promise<void>((resolve) =>
        server.listen(0, "127.0.0.1", resolve),
      );
      const address = server.address();
      if (!address || typeof address === "string")
        throw new Error("No fixture address");
      const connection = {
        url: `http://127.0.0.1:${address.port}/mcp`,
        timeout: 10_000,
        clientCapabilities: {
          extensions: {
            "io.modelcontextprotocol/ui": {
              mimeTypes: ["text/html;profile=mcp-app"],
            },
          },
        },
      };
      await producing.connectToServer("fixture", {
        ...connection,
        ...setup.value?.effectiveInitializePins,
      });
      await app.connectToServer("fixture", {
        ...connection,
        ...buildHostConnectionPins(host, 300_000).initializePins,
      });
      expect(retainedProfileFingerprint(producing, "fixture")).toBe(
        retainedProfileFingerprint(app, "fixture"),
      );
    } finally {
      await producing.disconnectAllServers();
      await app.disconnectAllServers();
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      );
    }
  });
});
