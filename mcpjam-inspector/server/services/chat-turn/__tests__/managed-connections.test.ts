import {
  getManagerResourceSnapshot,
  setManagerResourceSnapshots,
} from "../../../utils/mcp-connections";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Hono } from "hono";
import { HOSTED_HARNESS_INPUT_VERSION } from "../../../../shared/hosted-elicitation";
const m = vi.hoisted(() => ({ order: [] as string[], authorize: vi.fn(), refused: {} as Record<string, unknown> }));
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
  createAuthorizedManager: m.authorize.mockImplementation(async () => ({
    manager: {
      disconnectAllServers: async () => {
        m.order.push("disconnect servers");
      },
      getInitializationInfo: () => undefined,
    },
    oauthServerUrls: {},
    authenticatedUserId: "user-1",
    refusedServers: m.refused,
  })),
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
    m.authorize.mockClear();
    m.refused = {};
  });
  afterEach(() => vi.unstubAllEnvs());

  it.each([
    { host: null, expected: false },
    { host: { computer: null }, expected: false },
    { host: { computer: { kind: "personal" } }, expected: true },
  ])(
    "uses only resolved host Computer attachment ($expected)",
    async ({ host, expected }) => {
      const resources = new TurnResources((error) => {
        throw error;
      });
      const app = new Hono();
      app.post("/", async (c) => {
        await prepareManagedConnections({
          c,
          rawBody: {
            computer: { kind: "personal" },
            pluginComputerRuntime: true,
          },
          bearerToken: "bearer",
          rpcCollector: createHostedRpcLogCollector({}),
          resources,
          setup: { ...setup, hostRuntimeConfig: host },
          onOAuthServerUrls: () => {},
        });
        return c.json({ ok: true });
      });
      expect((await app.request("/", { method: "POST" })).status).toBe(200);
      expect(m.authorize.mock.calls[0][7].pluginComputerRuntime).toBe(expected);
      await resources.dispose();
    },
  );

  it.each([
    {
      harness: "claude-code" as const,
      expected: true,
      resolved: false,
      rail: "hosted" as const,
    },
    {
      harness: "codex" as const,
      expected: true,
      resolved: false,
      rail: "hosted" as const,
    },
    {
      harness: "cursor" as const,
      expected: false,
      resolved: false,
      rail: "hosted" as const,
    },
    {
      harness: "codex" as const,
      expected: true,
      resolved: true,
      rail: "hosted" as const,
    },
    {
      harness: "claude-code" as const,
      expected: true,
      resolved: false,
      rail: "org" as const,
    },
    {
      harness: "codex" as const,
      expected: true,
      resolved: false,
      rail: "org" as const,
    },
    {
      harness: "codex" as const,
      expected: false,
      resolved: false,
      rail: "own-key" as const,
    },
    {
      harness: "codex" as const,
      expected: false,
      resolved: false,
      rail: "local" as const,
    },
  ])(
    "installs owned input for $harness on $rail (saved host: $resolved)",
    async ({ harness, expected, resolved, rail }) => {
      vi.stubEnv("HARNESS_NATIVE_FORWARDING", "true");
      const resources = new TurnResources((error) => {
        throw error;
      });
      const app = new Hono();
      app.post("/", async (c) => {
        const prepared = await prepareManagedConnections({
          c,
          rawBody: { hostedHarnessInputVersion: HOSTED_HARNESS_INPUT_VERSION },
          bearerToken: "bearer",
          rpcCollector: createHostedRpcLogCollector({}),
          resources,
          setup: {
            ...setup,
            turnRail: rail,
            hostId: resolved ? undefined : "host",
            isHostAuthoritative: resolved,
            ...(resolved
              ? {
                  hostRuntimeConfig: {
                    hostConfigId: "saved-config",
                    hostId: "saved-host",
                    hostStyle: "codex" as const,
                    modelId: "openai/gpt-5.5",
                    systemPrompt: "",
                    temperature: 0,
                    requireToolApproval: true,
                  },
                }
              : {}),
            resolvedExecution: { ...setup.resolvedExecution, harness },
          },
          onOAuthServerUrls: () => {},
        });
        return c.json({ ownedInput: prepared.harnessOwnedInput });
      });
      const response = await app.request("/", { method: "POST" });
      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({ ownedInput: expected });
      await resources.dispose();
    },
  );

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
        setup: {
          ...setup,
          hostRuntimeConfig: {
            hostConfigId: "saved-host-config",
            hostId: "host",
            hostStyle: "claude",
            modelId: "anthropic/claude-haiku-4.5",
            systemPrompt: "",
            temperature: 0,
            requireToolApproval: false,
          },
        },
        onOAuthServerUrls: () => {},
      });
      setManagerResourceSnapshots(
        prepared.manager,
        new Map([
          ["server-1", { serverUpdatedAt: 1, credentialAuthorizedAt: null }],
        ]),
      );
      expect(
        getManagerResourceSnapshot(prepared.manager, "server-1")?.hostConfigId,
      ).toBe("saved-host-config");
      return c.json({});
    });
    expect((await app.request("/", { method: "POST" })).status).toBe(200);
    await resources.dispose();
    expect(m.order).toEqual(["withdraw elicitations", "disconnect servers"]);
  });
});

it("continues a real managed setup only for automatic unapproved additions", async () => {
  const { ErrorCode, WebRouteError } = await import("../../../routes/web/errors.js");
  const error = new WebRouteError(403, ErrorCode.STDIO_COMMAND_APPROVAL_REQUIRED, "Review command");
  const value: Setup = {
    ...setup,
    environmentSpec: {
      environmentOrigin: "adhoc", environmentRef: { environmentId: "env", name: "Chat", revision: 1 },
      host: { hostId: "host", runtimeConfig: {} },
      servers: { effectiveServerIds: ["server-1", "automatic"] },
    },
    effectiveCapabilities: {
      explicitServerIds: ["server-1"], pluginServerIds: ["automatic"], effectiveServerIds: ["server-1", "automatic"],
      servers: [], pluginSkills: [], standaloneSkills: [], serverSkills: [], localSkills: [], pluginVersions: [], problems: [],
    },
    effectiveServerIds: ["server-1", "automatic"],
  };
  const run = async (refused: Record<string, unknown>, automatic: string[]) => {
    m.refused = refused;
    const resources = new TurnResources((failure) => { throw failure; });
    const app = new Hono();
    app.onError((failure) => { throw failure; });
    let retained: unknown;
    app.post("/", async (c) => {
      const result = await prepareManagedConnections({ c, rawBody: { autoContributedPluginServerIds: automatic },
        bearerToken: "bearer", rpcCollector: createHostedRpcLogCollector({}), resources, setup: value,
        onOAuthServerUrls: () => {}, });
      retained = result.refusedServers;
      return c.json({ ok: true });
    });
    try { await app.request("/", { method: "POST" }); return retained; }
    finally { await resources.dispose(); }
  };
  expect(await run({ automatic: error }, ["automatic"])).toEqual({ automatic: error });
  await expect(run({ automatic: error }, [])).rejects.toBe(error);
  await expect(run({ automatic: error, "server-1": error }, ["automatic", "server-1"])).rejects.toBe(error);
});
