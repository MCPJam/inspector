import { beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import type { Context } from "hono";
import {
  pluginHostBindingDigest,
  pluginServerBindingDigest,
} from "../bindings";
const f = vi.hoisted(() => ({
  query: vi.fn(),
  connect: vi.fn(),
  list: vi.fn(),
  disconnect: vi.fn(),
  initialize: vi.fn(),
  forms: vi.fn(),
  cancel: vi.fn(),
  hosted: false,
  registries: [] as { input: any; registry: any }[],
  // The era the fixture connection negotiates, and the MRTR collectors it
  // was given before connect.
  negotiated: "2025-11-25",
  collectors: [] as ((args: any) => Promise<unknown>)[],
  // When set, owned MRTR services answer through this fixture instead.
  fakeMrtr: undefined as
    | undefined
    | { execute: (...args: any[]) => unknown; collector: (args: any) => unknown },
}));
vi.mock("../../../config.js", async (original) => ({
  ...(await original<typeof import("../../../config.js")>()),
  get HOSTED_MODE() {
    return f.hosted;
  },
}));
vi.mock("@mcpjam/sdk/internal/plugin-host", async (original) => {
  const actual = await original<
    typeof import("@mcpjam/sdk/internal/plugin-host")
  >();
  return {
    ...actual,
    createPluginCapabilityRegistry: (
      input: Parameters<typeof actual.createPluginCapabilityRegistry>[0],
    ) => {
      const registry = actual.createPluginCapabilityRegistry(input);
      f.registries.push({ input, registry });
      return registry;
    },
  };
});
vi.mock("../owned-mrtr.js", async (original) => {
  const actual = await original<typeof import("../owned-mrtr.js")>();
  return {
    ...actual,
    createOwnedPluginMrtr: (
      deps: Parameters<typeof actual.createOwnedPluginMrtr>[0],
    ) => {
      const real = actual.createOwnedPluginMrtr(deps);
      return f.fakeMrtr ? { ...real, ...f.fakeMrtr } : real;
    },
  };
});
vi.mock("../owned-legacy.js", async (original) => ({
  ...(await original<typeof import("../owned-legacy.js")>()),
  createOwnedPluginLegacyForms: f.forms,
}));
vi.mock("../../evals/route-helpers.js", () => ({
  createConvexClient: () => ({ query: f.query }),
}));
vi.mock("../../../utils/mrtr-continuation-state.js", async (original) => ({
  ...(await original<
    typeof import("../../../utils/mrtr-continuation-state.js")
  >()),
  cancelContinuation: f.cancel,
}));
vi.mock("../../../routes/web/auth.js", () => ({
  projectServerSchema: z.object({
    projectId: z.string(),
    serverId: z.string(),
  }),
  createManualHostedConnection: f.connect,
}));
import {
  admitPluginWorkspace,
  readPluginExecutionContext,
  pluginResolverIncludesAdmission,
} from "../admission";
import {
  assertPluginInstanceBindingCurrent,
  createPluginRequestRuntime,
} from "../request-runtime";
import { pluginConnectionPool } from "../connection-pool";
import {
  pluginInstances,
  type PluginInstanceAdmissionRead,
} from "../instances";
import { pluginFormSources } from "../form-sources";
import { pluginFormFileGrants } from "../form-file-grants";
const config = {
  hostId: "host",
  modelId: "model",
  systemPrompt: "",
  temperature: 0,
  requireToolApproval: false,
  hostStyle: "chatgpt",
  executionScope: { kind: "project", projectId: "project" },
};
const tool = { name: "app", inputSchema: { type: "object" } };
let target = {
  url: "https://fixture.invalid/mcp",
  requestInit: { headers: { Authorization: "fixture-credential" } },
};
let credentialId = "saved-credential";
const identity = () => ({
  serverId: "server",
  credentialId,
  credentialAuthorizedAt: 100,
  config: {
    transportType: "http",
    url: target.url,
    credentialConfigurationId: "a".repeat(64),
  },
});
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
beforeEach(async () => {
  await pluginConnectionPool.clear();
  vi.restoreAllMocks();
  vi.resetAllMocks();
  credentialId = "saved-credential";
  f.hosted = false;
  f.registries.length = 0;
  f.negotiated = "2025-11-25";
  f.collectors.length = 0;
  f.fakeMrtr = undefined;
  target = {
    url: "https://fixture.invalid/mcp",
    requestInit: { headers: { Authorization: "fixture-credential" } },
  };
  f.query.mockImplementation(async (_, args) => ({
    actorId: "actor",
    projectId: "project",
    ...(args.hostId ? { hostConfig: config } : {}),
    serverBindings: args.serverIds?.map((serverId: string) => ({
      kind: "standalone",
      serverId,
    })),
  }));
  f.list.mockResolvedValue({ tools: [tool] });
  f.disconnect.mockResolvedValue(undefined);
  let formOwners = 0;
  f.forms.mockImplementation(() => {
    const tag = `forms-${++formOwners}`;
    return {
      binding: { handler: async () => ({ tag }) },
      run: async (_a: unknown, _i: unknown, _s: unknown, run: () => unknown) =>
        run(),
      dispose: async () => {},
    };
  });
  f.connect.mockImplementation(async () => {
    const authorizedTarget = structuredClone(target);
    let connected = false;
    return {
      authorizedServerConfigs: { server: authorizedTarget },
      authorizedServerIdentities: { server: identity() },
      manager: {
        listTools: f.list,
        getServerCapabilities: () => ({}),
        disconnectAllServers: async () => {
          connected = false;
          await f.disconnect();
        },
        connectToServer: async () => {
          await f.initialize();
          connected = true;
        },
        getConnectionStatus: () => (connected ? "connected" : "disconnected"),
        getServerConfig: () => (connected ? authorizedTarget : undefined),
        getInitializationInfo: () => ({ protocolVersion: f.negotiated }),
        setMrtrInputCollector: (
          _serverId: string,
          collect: (args: any) => Promise<unknown>,
        ) => {
          f.collectors.push(collect);
        },
      },
    };
  });
});
async function runtime(
  expected?: Parameters<typeof createPluginRequestRuntime>[4],
) {
  const admission = await admitPluginWorkspace({
    projectId: "project",
    bearer: "fixture",
    descriptor: { version: 1, workspaceId: "workspace" },
  });
  return createPluginRequestRuntime(
    {} as Context,
    admission,
    "fixture",
    {
      hostId: "host",
      serverId: "server",
    },
    expected,
  );
}
describe("fresh request runtime admission", () => {
  it("brands only its exact full fresh resolver, not a wrapper or caller property", async () => {
    const live = await runtime();
    expect(pluginResolverIncludesAdmission(live.resolve)).toBe(true);
    expect(
      pluginResolverIncludesAdmission(
        (...args: Parameters<typeof live.resolve>) => live.resolve(...args),
      ),
    ).toBe(false);
    expect(
      pluginResolverIncludesAdmission({ admissionIsPartOfResolution: true }),
    ).toBe(false);
    await live.release();
  });

  it.each(["OAuth", "XAA"])(
    "keeps an instance when %s rotates its wire token",
    async () => {
      const expected = {
        hostRevision: pluginHostBindingDigest(config),
        serverIdentity: { kind: "standalone" as const, serverId: "server" },
        owner: { bindingId: pluginServerBindingDigest(identity()) },
      } as Parameters<typeof createPluginRequestRuntime>[4];
      const live = await runtime(expected);
      await live.resolve("app", new AbortController().signal);
      target.requestInit.headers.Authorization = "new-wire-token";
      await expect(
        live.resolve("app", new AbortController().signal),
      ).resolves.toMatchObject({ tool });
      await live.release();
    },
  );

  it("starts independent admission reads together but waits for both before target authorization and after metadata", async () => {
    const live = await runtime();
    const first = deferred<void>();
    const second = deferred<void>();
    let reads = 0;
    const read = async <T>(query: () => Promise<T>): Promise<T> => {
      const gate = reads++ === 0 ? first : second;
      const [, result] = await Promise.all([gate.promise, query()]);
      return result;
    };
    const resolving = live.resolve("app", new AbortController().signal, read);
    await vi.waitFor(() => expect(f.query).toHaveBeenCalledTimes(2));
    expect(f.connect).not.toHaveBeenCalled();
    first.resolve();
    await vi.waitFor(() => expect(reads).toBe(2));
    expect(f.query).toHaveBeenCalledTimes(3);
    let delivered = false;
    void resolving.then(() => {
      delivered = true;
    });
    await Promise.resolve();
    expect(delivered).toBe(false);
    second.resolve();
    expect((await resolving).tool).toEqual(tool);
    expect(reads).toBe(2);
    await live.release();
  });
  it.each(["before target", "after metadata"])(
    "refuses a failed durable ownership check %s even when atomic admission succeeds",
    async (phase) => {
      const live = await runtime();
      let reads = 0;
      const read = async <T>(query: () => Promise<T>): Promise<T> => {
        const result = await query();
        if (++reads === (phase === "before target" ? 1 : 2))
          throw new Error("INSTANCE_UNAVAILABLE");
        return result;
      };
      await expect(
        live.resolve("app", new AbortController().signal, read),
      ).rejects.toThrow("INSTANCE_UNAVAILABLE");
      expect(f.connect).toHaveBeenCalledTimes(
        phase === "before target" ? 0 : 1,
      );
      expect(f.list).toHaveBeenCalledTimes(phase === "before target" ? 0 : 1);
      await live.release();
    },
  );
  it("reads saved host and server authority atomically, and checks again after catalog waits", async () => {
    const live = await runtime();
    const host = deferred<{
      actorId: string;
      projectId: string;
      serverBindings: { kind: string; serverId: string }[];
      hostConfig: typeof config;
    }>();
    const catalog = deferred<{ tools: (typeof tool)[] }>();
    f.query.mockReturnValueOnce(host.promise);
    f.list.mockReturnValueOnce(catalog.promise);
    const resolving = live.resolve("app", new AbortController().signal);
    await vi.waitFor(() => expect(f.query).toHaveBeenCalledTimes(2));
    expect(f.connect).not.toHaveBeenCalled();
    host.resolve({
      actorId: "actor",
      projectId: "project",
      serverBindings: [{ kind: "standalone", serverId: "server" }],
      hostConfig: config,
    });
    await vi.waitFor(() => expect(f.list).toHaveBeenCalledOnce());
    catalog.resolve({ tools: [tool] });
    expect((await resolving).tool).toEqual(tool);
    expect(f.query).toHaveBeenCalledTimes(3);
    expect(f.query.mock.calls.slice(1).map((call) => call[1])).toEqual([
      { projectId: "project", serverIds: ["server"], hostId: "host" },
      { projectId: "project", serverIds: ["server"], hostId: "host" },
    ]);
    await live.release();
    // The authorized connection stays briefly reusable, then closes.
    expect(f.disconnect).not.toHaveBeenCalled();
    expect(pluginConnectionPool.idleSize).toBe(1);
    await pluginConnectionPool.clear();
    expect(f.disconnect).toHaveBeenCalledOnce();
  });
  it.each(["membership", "actor", "binding", "host"] as const)(
    "refuses changed %s after metadata without dispatch authority",
    async (change) => {
      const live = await runtime();
      const catalog = deferred<{ tools: (typeof tool)[] }>();
      f.list.mockReturnValueOnce(catalog.promise);
      const resolving = live.resolve("app", new AbortController().signal);
      // Observe the rejection immediately, including a failed parallel leg.
      const rejected = expect(resolving).rejects.toThrow();
      await vi.waitFor(() => expect(f.list).toHaveBeenCalledOnce());
      if (change === "membership")
        f.query.mockRejectedValueOnce(new Error("revoked"));
      if (change === "actor")
        f.query.mockResolvedValueOnce({
          actorId: "foreign",
          projectId: "project",
          serverBindings: [{ kind: "standalone", serverId: "server" }],
        });
      if (change === "binding")
        f.query.mockResolvedValueOnce({
          actorId: "actor",
          projectId: "project",
          serverBindings: [{ kind: "standalone", serverId: "foreign" }],
        });
      if (change === "host")
        f.query.mockResolvedValueOnce({
          actorId: "actor",
          projectId: "project",
          serverBindings: [{ kind: "standalone", serverId: "server" }],
          // An identity field: approval and extension toggles are re-read
          // per request instead of binding the App.
          hostConfig: { ...config, harness: "codex" },
        });
      catalog.resolve({ tools: [tool] });
      await rejected;
      await live.release();
      await pluginConnectionPool.clear();
      expect(f.disconnect).toHaveBeenCalledOnce();
    },
  );
  it("refuses initial atomic admission failure before connection construction", async () => {
    const live = await runtime();
    f.query.mockRejectedValueOnce(new Error("rollout unavailable"));
    await expect(
      live.resolve("app", new AbortController().signal),
    ).rejects.toThrow();
    expect(f.connect).not.toHaveBeenCalled();
    await live.release();
  });
  it("reuses the authorized connection within its window, and its listing within one request, but reads admission on every resolution", async () => {
    const live = await runtime();
    const first = await live.resolve("app", new AbortController().signal);
    f.list.mockResolvedValueOnce({
      tools: [{ ...tool, description: "changed" }],
    });
    const next = await live.resolve("app", new AbortController().signal);
    expect(f.connect).toHaveBeenCalledOnce();
    expect(f.connect.mock.calls[0][3].lazyConnect).toBe(true);
    expect(f.initialize).toHaveBeenCalledOnce();
    // One request lists once; its second resolution re-reads every backend
    // fact and stands on that listing.
    expect(f.list).toHaveBeenCalledOnce();
    // Admission; the cold resolution's read before and after its catalog;
    // the warm resolution's single read. Never skipped.
    expect(f.query).toHaveBeenCalledTimes(4);
    expect(next.revision).toBe(first.revision);
    expect(next.manager).toBe(first.manager);
    expect(f.disconnect).not.toHaveBeenCalled();
    await live.release();
    // A later request for the same binding reuses the same live session, and
    // lists again: it sees the changed declaration.
    const later = await runtime();
    const reused = await later.resolve("app", new AbortController().signal);
    expect(reused.manager).toBe(first.manager);
    expect(reused.revision).not.toBe(first.revision);
    expect(f.list).toHaveBeenCalledTimes(2);
    expect(
      f.list.mock.calls.every((call) => call[2].cacheMode === "bypass"),
    ).toBe(true);
    // Its own admission and one read: the connection is warm.
    expect(f.query).toHaveBeenCalledTimes(6);
    expect(f.connect).toHaveBeenCalledOnce();
    expect(f.initialize).toHaveBeenCalledOnce();
    await later.release();
    expect(f.disconnect).not.toHaveBeenCalled();
  });
  it("lists again for a tool this request has not listed", async () => {
    f.list.mockResolvedValue({
      tools: [tool, { name: "inspect", inputSchema: { type: "object" } }],
    });
    const live = await runtime();
    await live.resolve("app", new AbortController().signal);
    await live.resolve("inspect", new AbortController().signal);
    expect(f.list).toHaveBeenCalledOnce();
    f.list.mockResolvedValue({
      tools: [{ name: "late", inputSchema: { type: "object" } }],
    });
    await expect(
      live.resolve("late", new AbortController().signal),
    ).resolves.toMatchObject({ tool: { name: "late" } });
    expect(f.list).toHaveBeenCalledTimes(2);
    await live.release();
  });
  it("re-authorizes a connection in active use ahead of its window, off the request's path", async () => {
    const start = Date.now();
    const clock = vi.spyOn(Date, "now").mockReturnValue(start);
    const first = await runtime();
    const opened = await first.resolve("app", new AbortController().signal);
    await first.release();
    expect(f.connect).toHaveBeenCalledOnce();
    // Before half the window: nothing to refresh.
    clock.mockReturnValue(start + 20_000);
    const early = await runtime();
    await early.resolve("app", new AbortController().signal);
    await early.release();
    expect(f.connect).toHaveBeenCalledOnce();
    // Past half the window: the request answers on the current
    // authorization while a full one runs beside it.
    clock.mockReturnValue(start + 35_000);
    const slow = deferred<void>();
    const connect = f.connect.getMockImplementation()!;
    f.connect.mockImplementationOnce(async (...args) => {
      await slow.promise;
      return connect(...args);
    });
    const busy = await runtime();
    const used = await busy.resolve("app", new AbortController().signal);
    expect(used.manager).toBe(opened.manager);
    await busy.release();
    expect(f.connect).toHaveBeenCalledTimes(2);
    slow.resolve();
    // Its unused lazy manager is released; the live session is kept.
    await vi.waitFor(() => expect(f.disconnect).toHaveBeenCalledOnce());
    // 64 s after the first authorization (29 s after the refresh began): no
    // inline authorization, the same session.
    clock.mockReturnValue(start + 64_000);
    const later = await runtime();
    const reused = await later.resolve("app", new AbortController().signal);
    expect(reused.manager).toBe(opened.manager);
    expect(f.connect).toHaveBeenCalledTimes(2);
    expect(f.initialize).toHaveBeenCalledOnce();
    await later.release();
  });
  it.each(["changed target", "refused"])(
    "ends the window when a background re-authorization finds the target %s",
    async (outcome) => {
      const start = Date.now();
      const clock = vi.spyOn(Date, "now").mockReturnValue(start);
      const first = await runtime();
      const opened = await first.resolve("app", new AbortController().signal);
      await first.release();
      clock.mockReturnValue(start + 35_000);
      if (outcome === "refused")
        f.connect.mockRejectedValueOnce(new Error("credential revoked"));
      else target = { ...target, url: "https://moved.invalid/mcp" };
      const busy = await runtime();
      // This request still answers within the current window.
      expect(
        (await busy.resolve("app", new AbortController().signal)).manager,
      ).toBe(opened.manager);
      await busy.release();
      await vi.waitFor(() => expect(f.connect).toHaveBeenCalledTimes(2));
      // The next request authorizes in full at once (well inside 60 s).
      clock.mockReturnValue(start + 36_000);
      const next = await runtime();
      await next.resolve("app", new AbortController().signal).catch(() => {});
      expect(f.connect).toHaveBeenCalledTimes(3);
      await next.release();
    },
  );
  it("re-runs full target authorization after the window and keeps an unchanged session", async () => {
    const live = await runtime();
    const first = await live.resolve("app", new AbortController().signal);
    await live.release();
    const now = Date.now();
    vi.spyOn(Date, "now").mockReturnValue(now + 61_000);
    const later = await runtime();
    const next = await later.resolve("app", new AbortController().signal);
    expect(f.connect).toHaveBeenCalledTimes(2);
    expect(f.initialize).toHaveBeenCalledOnce();
    expect(next.manager).toBe(first.manager);
    // The unused lazy manager released its own authorization leases.
    expect(f.disconnect).toHaveBeenCalledOnce();
    await later.release();
  });
  it("never shares a connection between actors, hosts or concurrent requests", async () => {
    const one = await runtime();
    const two = await runtime();
    const a = await one.resolve("app", new AbortController().signal);
    const b = await two.resolve("app", new AbortController().signal);
    expect(a.manager).not.toBe(b.manager);
    expect(f.connect).toHaveBeenCalledTimes(2);
    await one.release();
    await two.release();
    expect(pluginConnectionPool.idleSize).toBe(1);
    // A changed host identity (not a per-request permission such as approval).
    f.query.mockImplementation(async (_, args) => ({
      actorId: "actor",
      projectId: "project",
      ...(args.hostId
        ? { hostConfig: { ...config, modelId: "other-model" } }
        : {}),
      serverBindings: args.serverIds?.map((serverId: string) => ({
        kind: "standalone",
        serverId,
      })),
    }));
    const changedHost = await runtime();
    const c = await changedHost.resolve("app", new AbortController().signal);
    expect(c.manager).not.toBe(a.manager);
    expect(c.manager).not.toBe(b.manager);
    expect(f.connect).toHaveBeenCalledTimes(3);
    await changedHost.release();
  });
  it.each([
    // No form handler on this wire: no claim the server could act on.
    ["2025-06-18", undefined],
    // MRTR answers standard form-mode elicitation (with OpenAI's inputs).
    ["2026-07-28", { form: {} }],
  ])(
    "claims forms on a %s wire only where a handler answers them",
    async (version, elicitation) => {
      const pinned = { ...config, mcpProfile: { mcpProtocolVersion: version } };
      f.query.mockImplementation(async (_, args) => ({
        actorId: "actor",
        projectId: "project",
        ...(args.hostId ? { hostConfig: pinned } : {}),
        serverBindings: args.serverIds?.map((serverId: string) => ({
          kind: "standalone",
          serverId,
        })),
      }));
      const owner = await runtime({
        hostRevision: pluginHostBindingDigest(pinned),
        serverIdentity: { kind: "standalone" as const, serverId: "server" },
        owner: {
          bindingId: pluginServerBindingDigest(identity()),
          workspaceId: "workspace",
        },
      } as Parameters<typeof createPluginRequestRuntime>[4]);
      await owner.resolve("app", new AbortController().signal);
      const options = f.connect.mock.calls[0][3];
      if (!elicitation)
        expect(
          options.hostConfig.clientCapabilities.extensions?.[
            "openai/elicitation"
          ],
        ).toBeUndefined();
      expect(options.hostConfig.clientCapabilities.elicitation).toEqual(
        elicitation,
      );
      expect(options.extensionRequestHandlers).toBeUndefined();
      await owner.release();
    },
  );
  it.each([
    // The Codex and ChatGPT templates pin no protocol (auto negotiation).
    ["unpinned", {}],
    ["pinned to 2025-11-25", { mcpProtocolVersion: "2025-11-25" }],
  ])(
    "claims and answers OpenAI forms for an App on a %s client, withheld on a 2026 era",
    async (_label, mcpProfile) => {
      const host = { ...config, harness: "codex", mcpProfile };
      f.query.mockImplementation(async (_, args) => ({
        actorId: "actor",
        projectId: "project",
        ...(args.hostId ? { hostConfig: host } : {}),
        serverBindings: args.serverIds?.map((serverId: string) => ({
          kind: "standalone",
          serverId,
        })),
      }));
      const owner = await runtime({
        hostRevision: pluginHostBindingDigest(host),
        serverIdentity: { kind: "standalone" as const, serverId: "server" },
        owner: {
          bindingId: pluginServerBindingDigest(identity()),
          workspaceId: "workspace",
        },
      } as Parameters<typeof createPluginRequestRuntime>[4]);
      await owner.resolve("app", new AbortController().signal);
      const options = f.connect.mock.calls[0][3];
      expect(
        options.hostConfig.clientCapabilities.extensions["openai/elicitation"],
      ).toEqual({ form: {} });
      const [binding] = options.extensionRequestHandlers.server;
      expect(binding).toMatchObject({
        method: "openai/elicitation/create",
        legacyClaim: "openai/elicitation",
      });
      expect(f.forms).toHaveBeenCalledOnce();
      await owner.release();
    },
  );
  describe("an unpinned (Auto) client's form service follows the negotiated era", () => {
    const host = { ...config, mcpProfile: {} };
    const owner = {
      actorId: "actor",
      projectId: "project",
      workspaceId: "workspace",
      instanceId: "22222222-2222-4222-8222-222222222222",
      generation: 1,
      serverId: "server",
      bindingId: pluginServerBindingDigest(identity()),
      placement: "interactive" as const,
    };
    const authorization = {
      owner,
      origin: "app" as const,
      revision: "tool-revision",
      tool: { name: "app" },
      enabled: true,
      requiresApproval: false,
      allowedOrigins: ["app" as const],
    };
    async function autoOwner() {
      f.query.mockImplementation(async (_, args) => ({
        actorId: "actor",
        projectId: "project",
        ...(args.hostId ? { hostConfig: host } : {}),
        serverBindings: args.serverIds?.map((serverId: string) => ({
          kind: "standalone",
          serverId,
        })),
      }));
      f.fakeMrtr = {
        execute: vi.fn(async () => "modern-result"),
        collector: vi.fn(async () => "collected"),
      };
      const live = await runtime({
        hostRevision: pluginHostBindingDigest(host),
        serverIdentity: { kind: "standalone" as const, serverId: "server" },
        owner,
      } as Parameters<typeof createPluginRequestRuntime>[4]);
      const resolved = await live.resolve("app", new AbortController().signal);
      const options = f.connect.mock.calls[0][3];
      // Both handlers are prepared before connect: the era is not known yet.
      expect(options.hostConfig.clientCapabilities).toMatchObject({
        elicitation: { form: {} },
        extensions: { "openai/elicitation": { form: {} } },
      });
      expect(options.extensionRequestHandlers.server[0]).toMatchObject({
        method: "openai/elicitation/create",
        legacyClaim: "openai/elicitation",
      });
      expect(f.collectors).toHaveLength(1);
      return { live, resolved };
    }

    it("answers and dispatches MRTR when it negotiates 2026-07-28", async () => {
      f.negotiated = "2026-07-28";
      const { live, resolved } = await autoOwner();
      expect(resolved.transport).toBe("mrtr");
      // The connection's collector reaches this request's owned MRTR service.
      await expect(f.collectors[0]({ requests: [] })).resolves.toBe(
        "collected",
      );
      const run = vi.fn(async () => "original");
      await expect(
        live.runOwnedModern(
          authorization,
          "operation",
          { name: "app" },
          new AbortController().signal,
          run,
        ),
      ).resolves.toBe("modern-result");
      await expect(
        live.runOwnedLegacy(
          authorization,
          "operation",
          new AbortController().signal,
          run,
        ),
      ).rejects.toMatchObject({ code: "INSTANCE_DENIED" });
      expect(() => live.handleLegacyForm({})).toThrow("INSTANCE_DENIED");
      await live.release();
    });

    it("keeps the legacy form service when it negotiates a 2025 era", async () => {
      f.negotiated = "2025-11-25";
      const { live, resolved } = await autoOwner();
      expect(resolved.transport).toBe("legacy");
      // A 2025 era has no MRTR rounds; nothing answers one.
      await expect(f.collectors[0]({ requests: [] })).rejects.toMatchObject({
        code: "INSTANCE_DENIED",
      });
      const run = vi.fn(async () => "original");
      await expect(
        live.runOwnedLegacy(
          authorization,
          "operation",
          new AbortController().signal,
          run,
        ),
      ).resolves.toBe("original");
      expect(() =>
        live.runOwnedModern(
          authorization,
          "operation",
          { name: "app" },
          new AbortController().signal,
          run,
        ),
      ).toThrow("CONTINUATION_PROTOCOL_DENIED");
      expect(f.fakeMrtr!.execute).not.toHaveBeenCalled();
      await expect(live.handleLegacyForm({})).resolves.toMatchObject({
        tag: expect.stringMatching(/^forms-/),
      });
      await live.release();
    });
  });
  it("claims no OpenAI form for an unpinned client with Forms off", async () => {
    const host = {
      ...config,
      harness: "codex",
      mcpProfile: {
        profileVersion: 1,
        apps: {
          pluginExtensions: { enabled: true, capabilities: { forms: false } },
        },
      },
    };
    f.query.mockImplementation(async (_, args) => ({
      actorId: "actor",
      projectId: "project",
      ...(args.hostId ? { hostConfig: host } : {}),
      serverBindings: args.serverIds?.map((serverId: string) => ({
        kind: "standalone",
        serverId,
      })),
    }));
    const owner = await runtime({
      hostRevision: pluginHostBindingDigest(host),
      serverIdentity: { kind: "standalone" as const, serverId: "server" },
      owner: {
        bindingId: pluginServerBindingDigest(identity()),
        workspaceId: "workspace",
      },
    } as Parameters<typeof createPluginRequestRuntime>[4]);
    await owner.resolve("app", new AbortController().signal);
    const options = f.connect.mock.calls[0][3];
    expect(
      options.hostConfig.clientCapabilities.extensions?.["openai/elicitation"],
    ).toBeUndefined();
    expect(options.extensionRequestHandlers).toBeUndefined();
    expect(f.forms).not.toHaveBeenCalled();
    await owner.release();
  });
  it("routes a pooled connection's legacy form requests only to the request holding it", async () => {
    const legacy = {
      ...config,
      mcpProfile: { mcpProtocolVersion: "2025-11-25" },
    };
    f.query.mockImplementation(async (_, args) => ({
      actorId: "actor",
      projectId: "project",
      ...(args.hostId ? { hostConfig: legacy } : {}),
      serverBindings: args.serverIds?.map((serverId: string) => ({
        kind: "standalone",
        serverId,
      })),
    }));
    const expected = {
      hostRevision: pluginHostBindingDigest(legacy),
      serverIdentity: { kind: "standalone" as const, serverId: "server" },
      owner: {
        bindingId: pluginServerBindingDigest(identity()),
        workspaceId: "workspace",
      },
    } as Parameters<typeof createPluginRequestRuntime>[4];
    const owner = await runtime(expected);
    await owner.resolve("app", new AbortController().signal);
    const options = f.connect.mock.calls[0][3];
    expect(
      options.hostConfig.clientCapabilities.extensions["openai/elicitation"],
    ).toEqual({ form: {} });
    const handler = options.extensionRequestHandlers.server[0].handler;
    await expect(handler({})).resolves.toEqual({ tag: "forms-1" });
    await owner.release();
    await expect(handler({})).rejects.toThrow("INSTANCE_DENIED");
    // A request without an owned instance shares the connection but never
    // receives another request's forms.
    const anonymous = await runtime();
    await anonymous.resolve("app", new AbortController().signal);
    expect(f.connect).toHaveBeenCalledOnce();
    await expect(handler({})).rejects.toThrow("INSTANCE_DENIED");
    await anonymous.release();
    const next = await runtime(expected);
    await next.resolve("app", new AbortController().signal);
    expect(f.connect).toHaveBeenCalledOnce();
    await expect(handler({})).resolves.toEqual({ tag: "forms-2" });
    await next.release();
  });
  it.each([
    ["all on", {}, []],
    [
      "mentions and local files off",
      { mentions: false, localFiles: false },
      ["mentions", "file-open"],
    ],
  ] as const)(
    "decides desktop-only extensions from the client's toggles on a hosted deployment (%s)",
    async (_label, toggles, disabled) => {
      f.hosted = true;
      expect((await import("../../../config.js")).HOSTED_MODE).toBe(true);
      const profiled = {
        ...config,
        // A web platform hint is for responsive design and is never read.
        hostContext: { platform: "web" },
        mcpProfile: {
          profileVersion: 1,
          mcpProtocolVersion: "2025-11-25",
          apps: {
            pluginExtensions: { enabled: true, capabilities: toggles },
          },
        },
      };
      f.query.mockImplementation(async (_, args) => ({
        actorId: "actor",
        projectId: "project",
        ...(args.hostId ? { hostConfig: profiled } : {}),
        serverBindings: args.serverIds?.map((serverId: string) => ({
          kind: "standalone",
          serverId,
        })),
      }));
      const live = await runtime({
        hostRevision: pluginHostBindingDigest(profiled),
        serverIdentity: { kind: "standalone" as const, serverId: "server" },
        owner: {
          bindingId: pluginServerBindingDigest(identity()),
          workspaceId: "workspace",
        },
      } as Parameters<typeof createPluginRequestRuntime>[4]);
      const resolved = await live.resolve("app", new AbortController().signal);
      const toggled = toggles as Record<string, boolean>;
      for (const key of [
        "fileViewers",
        "mentions",
        "fileResources",
        "localFiles",
      ] as const)
        expect(resolved.extensions.capabilities[key]).toBe(
          toggled[key] !== false,
        );
      const { input, registry } = f.registries.at(-1)!;
      expect(input.profile).not.toHaveProperty("platform");
      expect(input.profile.disabledFeatures).toEqual(disabled);
      for (const feature of [
        "file-entrypoint",
        "mentions",
        "resources",
        "file-open",
      ])
        expect(registry.decision(feature).reason).toBe(
          (disabled as readonly string[]).includes(feature)
            ? "PROFILE_DISABLED"
            : // Offered: only this runtime's (absent) handlers remain.
              "HANDLER_UNIMPLEMENTED",
        );
      expect(f.forms.mock.calls[0][0].profile().fileResources).toBe(true);
      await live.release();
    },
  );
  it.each([true, false])(
    "states the client's File resources toggle (%s) in form profiles",
    async (fileResources) => {
      const profiled = {
        ...config,
        // Never read: the App-facing platform hint is for responsive design.
        hostContext: { platform: fileResources ? "web" : "desktop" },
        mcpProfile: {
          profileVersion: 1,
          mcpProtocolVersion: "2025-11-25",
          apps: {
            pluginExtensions: {
              enabled: true,
              capabilities: { fileResources },
            },
          },
        },
      };
      f.query.mockImplementation(async (_, args) => ({
        actorId: "actor",
        projectId: "project",
        ...(args.hostId ? { hostConfig: profiled } : {}),
        serverBindings: args.serverIds?.map((serverId: string) => ({
          kind: "standalone",
          serverId,
        })),
      }));
      const live = await runtime({
        hostRevision: pluginHostBindingDigest(profiled),
        serverIdentity: { kind: "standalone" as const, serverId: "server" },
        owner: {
          bindingId: pluginServerBindingDigest(identity()),
          workspaceId: "workspace",
        },
      } as Parameters<typeof createPluginRequestRuntime>[4]);
      const resolved = await live.resolve("app", new AbortController().signal);
      expect(resolved.extensions.capabilities.fileResources).toBe(
        fileResources,
      );
      const profile = f.forms.mock.calls[0][0].profile();
      expect(profile.fileResources).toBe(fileResources);
      expect(profile).not.toHaveProperty("platform");
      await live.release();
    },
  );
  it("enforces per-client extension toggles: no forms handler or claim, no model context", async () => {
    const profiled = {
      ...config,
      mcpProfile: {
        profileVersion: 1,
        mcpProtocolVersion: "2025-11-25",
        apps: {
          mcpAppsOverrides: { updateModelContext: true, message: true },
          pluginExtensions: {
            enabled: true,
            capabilities: { forms: false, modelContext: false },
          },
        },
      },
    };
    f.query.mockImplementation(async (_, args) => ({
      actorId: "actor",
      projectId: "project",
      ...(args.hostId ? { hostConfig: profiled } : {}),
      serverBindings: args.serverIds?.map((serverId: string) => ({
        kind: "standalone",
        serverId,
      })),
    }));
    const live = await runtime({
      hostRevision: pluginHostBindingDigest(profiled),
      serverIdentity: { kind: "standalone" as const, serverId: "server" },
      owner: {
        bindingId: pluginServerBindingDigest(identity()),
        workspaceId: "workspace",
      },
    } as Parameters<typeof createPluginRequestRuntime>[4]);
    const resolved = await live.resolve("app", new AbortController().signal);
    expect(resolved.contextEnabled).toBe(false);
    expect(resolved.messageEnabled).toBe(true);
    expect(resolved.extensions.capabilities.forms).toBe(false);
    expect(f.forms).not.toHaveBeenCalled();
    const options = f.connect.mock.calls[0][3];
    expect(options.extensionRequestHandlers).toBeUndefined();
    expect(
      options.hostConfig.clientCapabilities.extensions?.["openai/elicitation"],
    ).toBeUndefined();
    await live.release();
  });
  it("closes a pooled connection that is no longer connected instead of reusing it", async () => {
    const live = await runtime();
    const first = await live.resolve("app", new AbortController().signal);
    await live.release();
    await first.manager.disconnectAllServers();
    const later = await runtime();
    const next = await later.resolve("app", new AbortController().signal);
    expect(next.manager).not.toBe(first.manager);
    expect(f.connect).toHaveBeenCalledTimes(2);
    expect(f.initialize).toHaveBeenCalledTimes(2);
    await later.release();
  });
  it.each(["url", "credential"] as const)(
    "refuses freshly changed %s before initialization of the candidate",
    async (change) => {
      const expected = {
        hostRevision: pluginHostBindingDigest(config),
        serverIdentity: { kind: "standalone" as const, serverId: "server" },
        owner: { bindingId: pluginServerBindingDigest(identity()) },
      } as Parameters<typeof createPluginRequestRuntime>[4];
      const live = await runtime(expected);
      await live.resolve("app", new AbortController().signal);
      if (change === "url") target.url = "https://changed.invalid/mcp";
      else credentialId = "other-saved-credential";
      // Within the reuse window the change applies at the next full
      // authorization, which is at most one window away.
      vi.spyOn(Date, "now").mockReturnValue(Date.now() + 61_000);
      await expect(
        live.resolve("app", new AbortController().signal),
      ).rejects.toThrow("INSTANCE_CONNECTION_CHANGED");
      expect(f.initialize).toHaveBeenCalledOnce();
      expect(f.list).toHaveBeenCalledOnce();
      // The unused candidate and the stale live session both close; the stale
      // session is never offered to a later request.
      expect(f.disconnect).toHaveBeenCalledTimes(2);
      await live.release();
      expect(pluginConnectionPool.idleSize).toBe(0);
      expect(f.disconnect).toHaveBeenCalledTimes(2);
    },
  );
  it("never reuses a live connection when fresh full target authorization refuses", async () => {
    const live = await runtime();
    await live.resolve("app", new AbortController().signal);
    vi.spyOn(Date, "now").mockReturnValue(Date.now() + 61_000);
    f.connect.mockRejectedValueOnce(new Error("credential origin refused"));
    await expect(
      live.resolve("app", new AbortController().signal),
    ).rejects.toThrow("credential origin refused");
    expect(f.initialize).toHaveBeenCalledOnce();
    expect(f.list).toHaveBeenCalledOnce();
    await live.release();
    expect(f.disconnect).toHaveBeenCalledOnce();
  });
});

describe("retained App binding and the client's current toggles", () => {
  // What a saved host projects: the config's content address rotates with
  // every saved edit, the extension toggles included.
  let host: Record<string, unknown>;
  const toggles = (
    pluginExtensions: Record<string, unknown>,
    configId = "config-2",
  ) => {
    host = {
      ...config,
      hostConfigId: configId,
      mcpProfile: { profileVersion: 1, apps: { pluginExtensions } },
    };
  };
  beforeEach(() => {
    toggles({ enabled: true }, "config-1");
    f.query.mockImplementation(async (_, args) => ({
      actorId: "actor",
      projectId: "project",
      ...(args.hostId ? { hostConfig: host } : {}),
      serverBindings: args.serverIds?.map((serverId: string) => ({
        kind: "standalone",
        serverId,
      })),
    }));
  });
  const opened = (kind = "thread") => ({
    hostId: "host",
    hostRevision: pluginHostBindingDigest(host),
    serverIdentity: { kind: "standalone" as const, serverId: "server" },
    owner: {
      serverId: "server",
      bindingId: pluginServerBindingDigest(identity()),
      workspaceId: "workspace",
    },
    activation: { selector: { kind } },
  });
  async function retained(
    instance: ReturnType<typeof opened>,
    options?: Parameters<typeof createPluginRequestRuntime>[5],
  ) {
    const admission = await admitPluginWorkspace({
      projectId: "project",
      bearer: "fixture",
      descriptor: { version: 1, workspaceId: "workspace" },
    });
    const live = createPluginRequestRuntime(
      {} as Context,
      admission,
      "fixture",
      { hostId: "host", serverId: "server" },
      instance as unknown as Parameters<typeof createPluginRequestRuntime>[4],
      options,
    );
    const renew = () =>
      assertPluginInstanceBindingCurrent({
        admission,
        bearer: "fixture",
        instance: instance as never,
        signal: new AbortController().signal,
      });
    return { live, renew };
  }

  it("keeps an open App's requests and renewal working when another toggle changes", async () => {
    const app = opened();
    const { live, renew } = await retained(app);
    await live.resolve("app", new AbortController().signal);
    // Mentions off: a new config id and a new toggle, same App binding.
    toggles({ enabled: true, capabilities: { mentions: false } });
    await expect(
      live.resolve("app", new AbortController().signal),
    ).resolves.toMatchObject({ tool, hostRevision: app.hostRevision });
    await expect(live.verifyCurrent(new AbortController().signal)).resolves.toBe(
      undefined,
    );
    await expect(renew()).resolves.toBeUndefined();
    await live.release();
  });

  it.each([
    ["thread", "conversationPanels"],
    ["global", "sidebarApps"],
    ["quick-action", "sidebarApps"],
    ["file", "fileViewers"],
  ] as const)(
    "keeps an open %s App's requests and renewal working with %s off",
    async (kind, launcher) => {
      const app = opened(kind);
      const { live, renew } = await retained(app);
      await live.resolve("app", new AbortController().signal);
      // A launcher toggle gates new opens only (activation admission).
      toggles({ enabled: true, capabilities: { [launcher]: false } });
      const resolved = await live.resolve("app", new AbortController().signal);
      expect(resolved.extensions.capabilities[launcher]).toBe(false);
      await expect(
        live.verifyCurrent(new AbortController().signal),
      ).resolves.toBeUndefined();
      await expect(renew()).resolves.toBeUndefined();
      await live.release();
      // A later request on the same App, in a new request runtime.
      const next = await retained(app);
      await expect(
        next.live.resolve("app", new AbortController().signal),
      ).resolves.toMatchObject({ tool });
      await next.live.release();
    },
  );

  it("refuses every retained App, and its renewal, once the master switch is off", async () => {
    for (const kind of ["thread", "global", "quick-action", "file"]) {
      toggles({ enabled: true }, "config-1");
      const { live, renew } = await retained(opened(kind));
      await live.resolve("app", new AbortController().signal);
      toggles({ enabled: false });
      await expect(
        live.resolve("app", new AbortController().signal),
      ).rejects.toThrow("PLUGIN_EXTENSION_DISABLED");
      await expect(renew()).rejects.toThrow("PLUGIN_EXTENSION_DISABLED");
      await live.release();
    }
  });

  it("refuses a settings control once settings are off", async () => {
    const { live, renew } = await retained(opened("settings"));
    await live.resolve("app", new AbortController().signal);
    toggles({ enabled: true, capabilities: { settings: false } });
    await expect(
      live.resolve("app", new AbortController().signal),
    ).rejects.toThrow("PLUGIN_EXTENSION_DISABLED");
    await expect(renew()).rejects.toThrow("PLUGIN_EXTENSION_DISABLED");
    await live.release();
  });

  it("refuses a mention lease once mentions are off", async () => {
    const { activation: _none, ...lease } = opened();
    const { live } = await retained(lease as ReturnType<typeof opened>, {
      ownedForms: false,
      extension: "mentions",
    });
    await live.resolve("app", new AbortController().signal);
    toggles({ enabled: true, capabilities: { mentions: false } });
    await expect(
      live.resolve("app", new AbortController().signal),
    ).rejects.toThrow("PLUGIN_EXTENSION_DISABLED");
    await live.release();
  });

  it.each([
    ["harness", { harness: "codex" }],
    ["Computer", { computer: { kind: "personal" } }],
    ["host style", { hostStyle: "codex" }],
  ])(
    "still refuses an identity change (%s) with INSTANCE_HOST_CHANGED",
    async (_, change) => {
      const app = opened();
      const { live, renew } = await retained(app);
      host = { ...host, ...change, hostConfigId: "config-3" };
      await expect(renew()).rejects.toThrow("INSTANCE_HOST_CHANGED");
      if (!("hostStyle" in change))
        await expect(
          live.resolve("app", new AbortController().signal),
        ).rejects.toThrow("INSTANCE_HOST_CHANGED");
      await live.release();
    },
  );
});

it("projects only bounded display names for admitted server IDs", async () => {
  f.query.mockResolvedValue({
    actorId: "actor",
    projectId: "project",
    serverBindings: [{ kind: "standalone", serverId: "server" }],
    serverNamesById: { server: "Bits & Bolts", foreign: "Never admitted" },
  });
  const input = {
    projectId: "project",
    bearer: "fixture",
    expectedActorId: "actor",
    serverIds: ["server"],
  };
  const named = await readPluginExecutionContext(input);
  expect(named.serverNamesById).toEqual({ server: "Bits & Bolts" });
  f.query.mockResolvedValue({
    actorId: "actor",
    projectId: "project",
    serverBindings: [{ kind: "standalone", serverId: "server" }],
    serverNamesById: { server: "x".repeat(513) },
  });
  expect((await readPluginExecutionContext(input)).serverNamesById).toEqual({});
});

describe("related-tool catalog resolution", () => {
  it("resolves both tools from one bypassed catalog behind both durable read fences", async () => {
    const live = await runtime();
    const requested = { name: "inspect", inputSchema: { type: "object" } };
    f.list.mockResolvedValueOnce({ tools: [tool, requested] });
    const read = vi.fn(
      async <T>(action: () => Promise<T>): Promise<T> => action(),
    );
    const resolved = await live.resolveTools(
      ["app", "inspect"],
      new AbortController().signal,
      read as PluginInstanceAdmissionRead,
    );
    expect(resolved.get("app")?.tool).toEqual(tool);
    expect(resolved.get("inspect")?.tool).toEqual(requested);
    expect(resolved.get("app")?.manager).toBe(resolved.get("inspect")?.manager);
    expect(f.list).toHaveBeenCalledOnce();
    expect(f.list.mock.calls[0][2].cacheMode).toBe("bypass");
    expect(f.connect).toHaveBeenCalledOnce();
    expect(read).toHaveBeenCalledTimes(2);
    await live.release();
  });

  it.each([1, 2])(
    "refuses both tools when durable fence %s rejects",
    async (failedRead) => {
      const live = await runtime();
      f.list.mockResolvedValue({
        tools: [tool, { name: "inspect", inputSchema: { type: "object" } }],
      });
      let reads = 0;
      const read = async <T>(action: () => Promise<T>): Promise<T> => {
        const result = await action();
        if (++reads === failedRead) throw new Error("INSTANCE_UNAVAILABLE");
        return result;
      };
      await expect(
        live.resolveTools(
          ["app", "inspect"],
          new AbortController().signal,
          read,
        ),
      ).rejects.toThrow("INSTANCE_UNAVAILABLE");
      expect(f.list).toHaveBeenCalledTimes(failedRead === 1 ? 0 : 1);
      await live.release();
    },
  );
});


describe("a pending form and the client's current capability toggles", () => {
  let host: Record<string, unknown>;
  const toggles = (
    capabilities: Record<string, boolean>,
    version = "2025-11-25",
  ) => {
    host = {
      ...config,
      hostConfigId: crypto.randomUUID(),
      mcpProfile: {
        profileVersion: 1,
        mcpProtocolVersion: version,
        apps: { pluginExtensions: { enabled: true, capabilities } },
      },
    };
  };
  const owner = {
    actorId: "actor",
    projectId: "project",
    workspaceId: "workspace",
    instanceId: "11111111-1111-4111-8111-111111111111",
    generation: 1,
    serverId: "server",
    bindingId: pluginServerBindingDigest(identity()),
    placement: "interactive" as const,
  };
  const authorization = {
    owner,
    origin: "app" as const,
    revision: "tool-revision",
    tool: { name: "app" },
    enabled: true,
    requiresApproval: false,
    allowedOrigins: ["app" as const],
  };
  beforeEach(() => {
    toggles({});
    f.query.mockImplementation(async (_, args) => ({
      actorId: "actor",
      projectId: "project",
      ...(args.hostId ? { hostConfig: host } : {}),
      serverBindings: args.serverIds?.map((serverId: string) => ({
        kind: "standalone",
        serverId,
      })),
    }));
    f.cancel.mockResolvedValue({ ok: true, status: "cancelled" });
    // The instance registry is exercised elsewhere; here the form owner is live.
    vi.spyOn(pluginInstances, "getFormOwner").mockReturnValue({} as never);
  });
  async function shown(
    schema: unknown = {
      type: "object",
      properties: { name: { type: "string" } },
    },
    origin: "app" | "model" = "app",
  ) {
    const live = await runtime({
      hostId: "host",
      hostRevision: pluginHostBindingDigest(host),
      serverIdentity: { kind: "standalone" as const, serverId: "server" },
      owner,
      subject: "subject",
      activation: { selector: { kind: "thread" } },
    } as unknown as Parameters<typeof createPluginRequestRuntime>[4]);
    await live.resolve("app", new AbortController().signal);
    const deps = f.forms.mock.calls.at(-1)![0];
    // The form opens: its owned source is bound with Forms on.
    await deps.assertCurrent();
    const rendezvousId = crypto.randomUUID();
    const form = await deps.bindForm({
      authorization: { ...authorization, origin },
      invocationId: "operation",
      signal: new AbortController().signal,
      rendezvousId,
      serverId: "server",
      schema,
      expiresAt: Date.now() + 60_000,
    });
    return { live, deps, form, rendezvousId };
  }
  const accept = { action: "accept", content: { name: "bolt" } } as const;

  it.each([
    { origin: "app", selection: "upload", reenable: false, refused: true },
    { origin: "app", selection: "upload", reenable: true, refused: false },
    { origin: "model", selection: "upload", reenable: false, refused: false },
    { origin: "app", selection: "explicit", reenable: false, refused: false },
    { origin: "app", selection: "omit", reenable: false, refused: false },
    { origin: "app", selection: "cancel", reenable: false, refused: false },
  ] as const)(
    "checks File resources at submit: $origin / $selection / reenabled=$reenable",
    async ({ origin, selection, reenable, refused }) => {
      const setFileResources = (enabled: boolean) => {
        toggles({ forms: true, fileResources: enabled });
        const profile = host.mcpProfile as Record<string, unknown>;
        host = {
          ...host,
          mcpProfile: {
            ...profile,
            extensions: {
              "mcpjam/plugin-local-form-files": {
                version: 1,
                serverIds: ["server"],
              },
            },
          },
        };
      };
      const connect = f.connect.getMockImplementation()!;
      f.connect.mockImplementation(async (...args) => {
        const connection = await connect(...args);
        connection.manager.getServerConfig = () => ({ command: "node" });
        return connection;
      });
      setFileResources(true);
      const explicitUri = "file:///existing.txt";
      const { live, form, rendezvousId } = await shown(
        {
          type: "object",
          properties: {
            file: {
              type: "string",
              format: "uri",
              "x-openai-input": {
                type: "resource",
                options: [{ uri: explicitUri, name: "Existing file" }],
                userOptions: { kind: "file" },
              },
            },
          },
        },
        origin,
      );
      const { source, signal } = pluginFormSources.get(form.token, owner, {
        kind: "legacy",
        id: rendezvousId,
        round: 0,
      });
      const releaseFiles = vi.fn(async () => {});
      try {
        const uploaded = await pluginFormFileGrants.upload({
          source,
          token: form.token,
          field: "file",
          operationId: crypto.randomUUID(),
          files: [
            {
              name: "answer.txt",
              type: "text/plain",
              bytes: Buffer.from("answer"),
            },
          ],
          signal: new AbortController().signal,
          sourceSignal: signal,
          authorize: async () => {},
          store: {
            reserve: async () => ({
              root: "/review",
              payload: "/review/files",
              release: releaseFiles,
            }),
            makeDir: async () => {},
            writeNew: async () => {},
            join: (...parts) => parts.join("/"),
          },
        });
        setFileResources(false);
        if (reenable) setFileResources(true);
        const answer =
          selection === "cancel"
            ? { action: "cancel" as const }
            : {
                action: "accept" as const,
                content:
                  selection === "omit"
                    ? {}
                    : {
                        file:
                          selection === "explicit"
                            ? explicitUri
                            : uploaded.uris[0],
                      },
              };
        if (refused) {
          await expect(form.deliver!(answer)).rejects.toMatchObject({
            code: "PLUGIN_FORM_WEB_UPLOAD_UNSUPPORTED",
            diagnostics: [
              expect.objectContaining({
                code: "PLUGIN_FORM_WEB_UPLOAD_UNSUPPORTED",
                title:
                  "Form submission refused: File resources is turned off for this client",
              }),
            ],
          });
          expect(live.diagnostics()).toEqual([
            expect.objectContaining({
              code: "PLUGIN_FORM_WEB_UPLOAD_UNSUPPORTED",
            }),
          ]);
          // Refusal must not promote uploads: closing the form removes them.
          form.release();
          await pluginFormFileGrants.drain();
          expect(releaseFiles).toHaveBeenCalledOnce();
        } else {
          const delivered = await form.deliver!(answer);
          if (selection === "upload") {
            expect(delivered).toEqual({
              action: "accept",
              content: {
                file: expect.stringMatching(/^file:\/\/\/review\/files\//),
              },
            });
          } else expect(delivered).toEqual(answer);
          expect(live.diagnostics()).toEqual([]);
        }
      } finally {
        pluginFormFileGrants.closeOperation(owner, "operation");
        await pluginFormFileGrants.drain();
        form.release();
        await live.release();
      }
    },
  );

  it("ends the form as cancelled, once, when Forms is off at submit", async () => {
    const { live, form } = await shown();
    toggles({ forms: false });
    await expect(form.deliver!(accept)).resolves.toEqual({ action: "cancel" });
    expect(live.diagnostics()).toEqual([
      expect.objectContaining({
        code: "PLUGIN_FORMS_DISABLED",
        serverId: "server",
        description: expect.stringContaining("ends as cancelled"),
      }),
    ]);
    // A user's own cancel is not a delivery: it passes once, unchanged.
    await expect(form.deliver!({ action: "cancel" })).resolves.toEqual({
      action: "cancel",
    });
    expect(live.diagnostics()).toHaveLength(1);
    form.release();
    await live.release();
  });

  it("delivers the answer when Forms is turned off and on again before submit", async () => {
    const { live, form } = await shown();
    toggles({ forms: false });
    toggles({ forms: true });
    await expect(form.deliver!(accept)).resolves.toEqual(accept);
    expect(live.diagnostics()).toEqual([]);
    form.release();
    await live.release();
  });

  it("lists again after a form step: a person could act before the next resolution", async () => {
    const { live, form } = await shown();
    expect(f.list).toHaveBeenCalledOnce();
    await live.resolve("app", new AbortController().signal);
    expect(f.list).toHaveBeenCalledTimes(2);
    // With no form step since, the next resolution stands on that listing.
    await live.resolve("app", new AbortController().signal);
    expect(f.list).toHaveBeenCalledTimes(2);
    form.release();
    await live.release();
  });

  it("never shows a new form once Forms is off", async () => {
    const { live, deps, form } = await shown();
    form.release();
    toggles({ forms: false });
    await deps.assertCurrent();
    await expect(
      deps.bindForm({
        authorization,
        invocationId: "operation",
        signal: new AbortController().signal,
        rendezvousId: crypto.randomUUID(),
        serverId: "server",
        schema: { type: "object", properties: {} },
        expiresAt: Date.now() + 60_000,
      }),
    ).rejects.toThrow("PLUGIN_FORMS_DISABLED");
    // The bridge answers the server with a cancel; the client's Logs say why.
    expect(live.diagnostics()).toEqual([
      expect.objectContaining({ code: "PLUGIN_FORMS_DISABLED" }),
    ]);
    await live.release();
  });

  it("ends a pending MRTR form as cancelled when Forms is off at resume", async () => {
    toggles({}, "2026-07-28");
    const expected = {
      hostId: "host",
      hostRevision: pluginHostBindingDigest(host),
      serverIdentity: { kind: "standalone" as const, serverId: "server" },
      owner,
      subject: "subject",
      activation: { selector: { kind: "thread" } },
    } as unknown as Parameters<typeof createPluginRequestRuntime>[4];
    toggles({ forms: false }, "2026-07-28");
    const bound = pluginFormSources.bind({
      owner,
      hostId: "host",
      hostRevision: expected!.hostRevision,
      invocationId: "operation",
      origin: "app",
      revision: "tool-revision",
      toolName: "app",
      parent: {
        kind: "mrtr",
        id: "continuation",
        round: 1,
        inputRequestKey: "input",
      },
      requestedSchema: { type: "object", properties: {} },
      expiresAt: Date.now() + 60_000,
    });
    const live = await runtime(expected);
    await live.resolve("app", new AbortController().signal);
    const ended = live.resumeMrtr(
      authorization,
      "operation",
      { name: "app" },
      { continuationId: "continuation", round: 1, responsesBlobId: "answer" },
      new AbortController().signal,
    );
    await expect(ended).rejects.toMatchObject({
      code: "PLUGIN_FORMS_DISABLED",
      diagnostics: [expect.objectContaining({ code: "PLUGIN_FORMS_DISABLED" })],
    });
    expect(f.cancel).toHaveBeenCalledExactlyOnceWith("fixture", {
      continuationId: "continuation",
      reason: "plugin_forms_disabled",
    });
    // Its form source closed with it: no later answer can find it.
    expect(() =>
      pluginFormSources.get(bound.token, owner, {
        kind: "mrtr",
        id: "continuation",
        round: 1,
        inputRequestKey: "input",
      }),
    ).toThrow("FORM_SOURCE_UNAVAILABLE");
    await live.release();
  });
});
