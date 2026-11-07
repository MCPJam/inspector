/**
 * The background workers act as the subscription's client: the executor and
 * the keeper connect with that client's saved settings (identity, protocol,
 * capabilities, conformance switches, timeout), the executor applies its
 * tool-visibility policy, and a run that cannot act as it fails with the
 * reason instead of falling back to MCPJam (built-in).
 */

import { afterEach, describe, expect, it, vi } from "vitest";
import type { EventRunClaim, EventRunInput } from "../backend-client.js";
import { executeClaimedEventRun, type EventExecutorDeps } from "../executor.js";
import { hostManagerArgs } from "../host-connection.js";

const authorizeMock = vi.hoisted(() => ({ createAuthorizedManager: vi.fn() }));
vi.mock("../../../routes/web/auth.js", () => authorizeMock);
const hostConfigMock = vi.hoisted(() => ({ fetchHostRuntimeConfig: vi.fn() }));
vi.mock("../../../utils/host-runtime-config.js", () => hostConfigMock);
const environmentMock = vi.hoisted(() => ({ resolveEnvironmentForLaunch: vi.fn() }));
vi.mock("../../environments/resolve.js", () => ({
  EVAL_LAUNCH_SERVER_SOURCE: "eval_launch",
  environmentServerIds: (resolved: { selectedServerIds: string[] }) =>
    resolved.selectedServerIds,
  environmentServerNames: () => [],
  resolveEnvironmentForLaunch: environmentMock.resolveEnvironmentForLaunch,
}));
vi.mock("../../evals/route-helpers.js", () => ({ createConvexClient: () => ({}) }));
vi.mock("../../../utils/v1-convex-token.js", () => ({
  getConvexBearerForDelegation: async () => "delegated-jwt",
}));

const SERVER_ID = "srv_events";

/** A ChatGPT client's runtime config, as `/web/host/runtime-config` returns it. */
const CHATGPT_CONFIG = {
  hostId: "host_chatgpt",
  hostConfigId: "cfg_chatgpt",
  hostStyle: "chatgpt",
  respectToolVisibility: false,
  clientCapabilities: { experimental: { "openai/visibility": { enabled: true } } },
  connectionDefaults: { headers: {}, requestTimeout: 4_000 },
  mcpProfile: {
    profileVersion: 1,
    paginationTraversal: "firstPageOnly",
    initialize: {
      clientInfo: { name: "openai-mcp", version: "1.0.0" },
      supportedProtocolVersions: ["2025-11-25"],
    },
  },
};

function claim(subscription: Partial<EventRunInput["subscription"]> = {}, trigger: Partial<EventRunInput["trigger"]> = {}): EventRunClaim {
  return {
    run: { _id: "run_1", projectId: "proj_1", triggerId: "trg_1", subscriptionId: "sub_1" },
    token: "lease_1",
    input: {
      trigger: {
        id: "trg_1",
        revision: 1,
        instructions: "Reply.",
        approvalPolicy: "auto_deny",
        maxSteps: 2,
        environmentId: null,
        ...trigger,
      },
      event: { eventId: "evt_1", name: "comment.created", data: {} },
      subscription: {
        id: "sub_1",
        generation: 1,
        bindingKey: "b".repeat(64),
        serverId: SERVER_ID,
        environmentId: null,
        ...subscription,
      },
    },
    messages: null,
    step: 0,
    calls: [],
    ownerExternalId: "user_1",
    organizationId: "org_1",
  };
}

function deps(): EventExecutorDeps & { backend: { finishRun: ReturnType<typeof vi.fn> } } {
  return {
    backend: {
      claimRun: vi.fn(async () => null),
      checkpointRun: vi.fn(async () => {}),
      beginCall: vi.fn(async () => ({ replay: false })),
      finishCall: vi.fn(async () => {}),
      finishRun: vi.fn(async () => {}),
    },
    transcript: false,
    getBearer: async () => "delegated-jwt",
  };
}

afterEach(() => {
  vi.clearAllMocks();
});

describe("hostManagerArgs", () => {
  it("reads identity, protocol, capabilities, conformance switches and timeout from the client", () => {
    const args = hostManagerArgs(CHATGPT_CONFIG, 30_000);
    expect(args.timeoutMs).toBe(4_000);
    expect(args.clientCapabilities).toEqual(CHATGPT_CONFIG.clientCapabilities);
    expect(args.options.initializePins).toMatchObject({
      clientInfo: { name: "openai-mcp", version: "1.0.0" },
      supportedProtocolVersions: ["2025-11-25"],
      firstPageOnly: true,
    });
  });

  it("is the SDK default for a client that pins nothing", () => {
    expect(hostManagerArgs({}, 30_000)).toEqual({ timeoutMs: 30_000, options: {} });
  });
});

describe("a trigger run acts as its subscription's client", () => {
  it("connects with the client's settings", async () => {
    hostConfigMock.fetchHostRuntimeConfig.mockResolvedValue({ ok: true, config: CHATGPT_CONFIG });
    authorizeMock.createAuthorizedManager.mockRejectedValueOnce(new Error("stop after connect"));
    await executeClaimedEventRun(claim({ hostId: "host_chatgpt" }), deps());

    expect(hostConfigMock.fetchHostRuntimeConfig).toHaveBeenCalledWith({
      hostId: "host_chatgpt",
      bearer: "delegated-jwt",
    });
    const call = authorizeMock.createAuthorizedManager.mock.calls[0]!;
    expect(call[4]).toBe(4_000);
    expect(call[6]).toEqual(CHATGPT_CONFIG.clientCapabilities);
    expect(call[7]).toMatchObject({
      initializePins: {
        clientInfo: { name: "openai-mcp", version: "1.0.0" },
        firstPageOnly: true,
      },
    });
  });

  it("applies the client's tool-visibility policy when preparing tools", async () => {
    const d = deps();
    const prepareChat = vi.fn(async () => {
      throw new Error("stop after prepare");
    });
    await executeClaimedEventRun(claim(), {
      ...d,
      resolveServers: async () => ({ serverIds: [SERVER_ID], hostConfig: CHATGPT_CONFIG }),
      connect: async () => ({ manager: {} as never, close: async () => {} }),
      resolveModel: async () => ({ id: "m", name: "m", provider: "openai" }) as never,
      prepareChat,
    });
    expect(prepareChat).toHaveBeenCalledWith(
      expect.objectContaining({ respectToolVisibility: false }),
    );
  });

  it("acts as MCPJam (built-in) with no client, exactly as before", async () => {
    authorizeMock.createAuthorizedManager.mockRejectedValueOnce(new Error("stop after connect"));
    await executeClaimedEventRun(claim({ hostId: null }), deps());
    expect(hostConfigMock.fetchHostRuntimeConfig).not.toHaveBeenCalled();
    const call = authorizeMock.createAuthorizedManager.mock.calls[0]!;
    expect(call[6]).toBeUndefined();
    expect(call[7]).toBeUndefined();
  });

  it("fails as host_missing when the client was deleted, without connecting", async () => {
    hostConfigMock.fetchHostRuntimeConfig.mockResolvedValue({ ok: false, status: 404, error: "Not found" });
    const d = deps();
    const outcome = await executeClaimedEventRun(claim({ hostId: "host_gone" }), d);
    expect(outcome).toEqual({ status: "failed", error: "host_missing" });
    expect(authorizeMock.createAuthorizedManager).not.toHaveBeenCalled();
    expect(d.backend.finishRun).toHaveBeenCalledWith(
      expect.objectContaining({ status: "failed", error: "host_missing" }),
    );
  });

  it("fails when the environment now pins another client, rather than acting as one nobody checked", async () => {
    environmentMock.resolveEnvironmentForLaunch.mockResolvedValue({
      hostId: "host_other",
      hostConfigId: "cfg_other",
      selectedServerIds: [SERVER_ID],
      environmentRef: { environmentId: "env_1", name: "Prod", revision: 1 },
    });
    const outcome = await executeClaimedEventRun(
      claim({ hostId: "host_chatgpt" }, { environmentId: "env_1" }),
      deps(),
    );
    expect(outcome).toEqual({ status: "failed", error: "environment_host_changed" });
    expect(authorizeMock.createAuthorizedManager).not.toHaveBeenCalled();
  });

  it("refuses a client edited between the environment's resolution and the config read", async () => {
    environmentMock.resolveEnvironmentForLaunch.mockResolvedValue({
      hostId: "host_chatgpt",
      hostConfigId: "cfg_before_edit",
      selectedServerIds: [SERVER_ID],
      environmentRef: { environmentId: "env_1", name: "Prod", revision: 1 },
    });
    hostConfigMock.fetchHostRuntimeConfig.mockResolvedValue({ ok: true, config: CHATGPT_CONFIG });
    const outcome = await executeClaimedEventRun(
      claim({ hostId: "host_chatgpt" }, { environmentId: "env_1" }),
      deps(),
    );
    expect(outcome).toEqual({ status: "failed", error: "host_changed" });
  });
});

describe("the keeper refreshes as the subscription's client", () => {
  async function tick(row: Record<string, unknown>) {
    const { runKeeperTick } = await import("../keeper.js");
    const subscription = {
      _id: "k57subscriptiondoc",
      projectId: "proj_1",
      organizationId: "org_1",
      environmentId: null,
      ownerUserId: "user_1",
      logicalId: "esub_1",
      binding: { serverId: SERVER_ID, credentialOwnerUserId: "user_1", credentialFingerprint: null },
      bindingKey: "b".repeat(64),
      locality: "hosted",
      eventName: "comment.created",
      arguments: {},
      mode: "poll",
      desiredState: "active",
      observedState: "pending",
      generation: 1,
      nextActionAt: 0,
      consecutiveFailures: 0,
      ...row,
    };
    const commits: unknown[] = [];
    await runKeeperTick(
      {
        backend: {
          claimSubscriptions: vi.fn(async () => [
            {
              subscription,
              leaseToken: "lease_1",
              generation: 1,
              ownerExternalId: "user_1",
              organizationId: "org_1",
            },
          ]),
          commitSubscription: vi.fn(async (request: { generation: number }) => {
            commits.push(request);
            return { ok: true as const, generation: request.generation };
          }),
          ensureInbox: vi.fn(async () => ({ inboxId: "inb_1" })),
        },
        // No unrecorded slot allocations: removal goes straight to the server.
        inboxFor: () =>
          ({
            findAllocation: async () => null,
            remove: async () => {},
            unbind: async () => {},
          }) as never,
      } as never,
      "inspector-test",
    );
    return commits;
  }

  it("connects with the client's settings, and needs no profile", async () => {
    hostConfigMock.fetchHostRuntimeConfig.mockResolvedValue({ ok: true, config: CHATGPT_CONFIG });
    authorizeMock.createAuthorizedManager.mockRejectedValueOnce(new Error("stop after connect"));
    await tick({ hostId: "host_chatgpt" });
    const call = authorizeMock.createAuthorizedManager.mock.calls[0]!;
    expect(call[4]).toBe(4_000);
    expect(call[6]).toEqual(CHATGPT_CONFIG.clientCapabilities);
    expect(call[7]).toMatchObject({
      initializePins: { clientInfo: { name: "openai-mcp", version: "1.0.0" } },
    });
  });

  it("still unsubscribes a removal whose client was deleted, as built-in", async () => {
    hostConfigMock.fetchHostRuntimeConfig.mockResolvedValue({ ok: false, status: 404, error: "Not found" });
    authorizeMock.createAuthorizedManager.mockRejectedValueOnce(new Error("stop after connect"));
    await tick({
      hostId: "host_gone",
      mode: "webhook",
      desiredState: "removed",
      observedState: "removing",
      callbackUrl: "https://hooks.mcpjam.com/i/inb_1/s/slot_1",
      serverSubscriptionId: "srv_sub_1",
    });
    expect(authorizeMock.createAuthorizedManager).toHaveBeenCalledTimes(1);
    const call = authorizeMock.createAuthorizedManager.mock.calls[0]!;
    expect(call[6]).toBeUndefined();
  });
});
