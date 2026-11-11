import { Hono } from "hono";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { settingsFixture } from "../../../../shared/__tests__/plugin-settings-fixture";

/**
 * Production runs several replicas with no sticky sessions, so each step of a
 * Settings session can reach a different one. Each "replica" here is a fresh
 * module graph, with its own instance registry and route state. What real
 * replicas share is shared here too:
 * - one control store, kept by the local store under the backend's rules;
 * - one receipt journal, modelled on the invoker's rules. A completed receipt
 *   replays its value without validating it again; a dispatched one whose
 *   replica died is an unknown outcome and never runs again.
 * The error module is shared as well, so a refusal raised in one graph is
 * still recognised in another.
 */
const shared = vi.hoisted(() => {
  const catalog = () => ({
    runtime: "chatgpt",
    hostRevision: "host-v1",
    bindingId: "binding",
    serverIdentity: { kind: "standalone" as const, serverId: "server" },
    transport: "legacy" as const,
    protocolVersion: "2025-11-25",
    appToolsEnabled: true,
    serverCapabilities: {
      experimental: {
        "openai/settings": { readTool: "read", updateTool: "save" },
      },
    },
    manager: {
      readResource: async () => ({
        contents: [
          {
            uri: "ui://settings",
            mimeType: "text/html;profile=mcp-app",
            text: "<p>settings</p>",
            _meta: { ui: { csp: {} } },
          },
        ],
      }),
    },
    tools: [
      {
        name: "read",
        inputSchema: { type: "object" as const },
        outputSchema: { type: "object" as const },
      },
      {
        name: "save",
        inputSchema: { type: "object" as const },
        outputSchema: { type: "object" as const },
      },
      {
        name: "reset",
        inputSchema: { type: "object" as const },
        _meta: { ui: { resourceUri: "ui://settings", visibility: ["app"] } },
      },
    ],
  });
  return {
    catalog,
    tools: undefined as undefined | ((current: ReturnType<typeof catalog>) => unknown),
    store: undefined as unknown,
    invocation: undefined as unknown,
    receipts: new Map<string, { state: "dispatched" | "completed"; body?: unknown }>(),
    call: (async () => ({})) as (params: {
      name: string;
      arguments?: Record<string, unknown>;
    }) => Promise<unknown>,
    storeDown: false,
    refuseSettingsWrites: false,
    /** Holds a request while its catalog loads, as a cold connection would. */
    catalogHold: undefined as undefined | (() => Promise<void>),
  };
});
vi.mock("../../../services/plugin-host/invocation.js", async (original) => {
  shared.invocation ??= await original();
  return shared.invocation as object;
});
vi.mock("../../../services/plugin-host/local-store.js", async (original) => {
  const actual =
    await original<typeof import("../../../services/plugin-host/local-store.js")>();
  shared.store ??= new actual.LocalPluginControlStore();
  const store = shared.store as InstanceType<typeof actual.LocalPluginControlStore>;
  const { PluginInvocationError } = await import(
    "../../../services/plugin-host/invocation.js"
  );
  return {
    ...actual,
    localPluginControls: {
      handler: (path: string, unavailable: string) => {
        const handle = store.handler(path, unavailable);
        return async (body: { action?: string }, signal: AbortSignal) => {
          if (
            shared.storeDown ||
            (shared.refuseSettingsWrites && body.action === "settings")
          )
            throw new PluginInvocationError(unavailable);
          return handle(body, signal);
        };
      },
    },
  };
});
vi.mock("../../../services/plugin-host/admission.js", async (original) => ({
  ...(await original<object>()),
  admitPluginWorkspace: async () => ({
    actorId: "actor",
    projectId: "project",
    workspaceId: "workspace",
    revalidate: async () => undefined,
  }),
  resolvePluginCleanupActor: async () => "actor",
}));
vi.mock("../../../utils/v1-convex-token.js", () => ({
  getConvexBearerForRequest: async () => "fixture-bearer",
}));
vi.mock("../../../utils/tool-approval-token.js", () => ({
  toolApprovalSubjectFromAuthHeader: () => "verified-subject",
}));
vi.mock("../../../services/plugin-host/request-runtime.js", () => ({
  createPluginRequestRuntime: () => ({
    catalog: async () => {
      await shared.catalogHold?.();
      const current = shared.catalog();
      return shared.tools ? shared.tools(current) : current;
    },
    release: async () => undefined,
  }),
  resolvePluginCatalogTool: (
    catalog: { tools: { name: string }[] },
    name: string,
  ) => ({
    ...catalog,
    tool: catalog.tools.find((tool) => tool.name === name),
    revision: name,
  }),
  assertPluginInstanceBindingCurrent: async () => undefined,
}));
vi.mock("../../../services/plugin-host/request-invocation.js", async () => {
  const { PluginInvocationError } = await import(
    "../../../services/plugin-host/invocation.js"
  );
  return {
    invokePluginRequest: async (
      c: { json: (body: unknown) => Response; req: { raw: Request } },
      input: {
        invocationId: string;
        params: { name: string; arguments?: Record<string, unknown> };
        resolve: (name: string, signal: AbortSignal) => Promise<unknown>;
        assertLive: () => void;
        assertOrigin: (resolved: unknown) => void;
        validate?: (resolved: unknown) => ((result: unknown) => void) | undefined;
        runtime: { release: () => Promise<void> };
      },
    ) => {
      try {
        const receipt = shared.receipts.get(input.invocationId);
        if (receipt?.state === "completed") return c.json(receipt.body);
        if (receipt?.state === "dispatched")
          throw new PluginInvocationError("INVOCATION_OUTCOME_UNKNOWN", true);
        const resolved = await input.resolve(input.params.name, c.req.raw.signal);
        input.assertLive();
        input.assertOrigin(resolved);
        shared.receipts.set(input.invocationId, { state: "dispatched" });
        const result = await shared.call(input.params);
        input.validate?.(resolved)?.(result);
        const body = { status: "completed", result };
        shared.receipts.set(input.invocationId, { state: "completed", body });
        return c.json(body);
      } finally {
        await input.runtime.release();
      }
    },
  };
});

type Replica = { post: (path: string, body: unknown) => Promise<Response> };
async function replica(): Promise<Replica> {
  vi.resetModules();
  const { default: routes } = await import("../plugin-settings");
  const app = new Hono().route("/settings", routes);
  return {
    post: async (path, body) =>
      app.request(`/settings/${path}`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: "Bearer fixture",
        },
        body: JSON.stringify(body),
      }),
  };
}
/** One at a time: a reset only isolates the import that follows it. */
async function replicas(count: number) {
  const created: Replica[] = [];
  for (let index = 0; index < count; index++) created.push(await replica());
  return created;
}

const scope = {
  projectId: "project",
  pluginWorkspace: { version: 1, workspaceId: "workspace" },
};
const plugin = {
  values: {} as Record<string, unknown>,
  reads: 0,
  updates: 0,
  resets: 0,
};
let hold: (() => Promise<void>) | undefined;

async function open(on: Replica) {
  const response = await on.post("open", {
    ...scope,
    hostId: "host",
    serverId: "server",
  });
  expect(response.status).toBe(200);
  return (await response.json()).instanceToken as string;
}
/** The client asks `/renew` before every leg, then sends the leg; each can
 * reach any replica. */
async function leg(
  renewOn: Replica,
  sendOn: Replica,
  token: string,
  method: "read" | "update",
  extra: Record<string, unknown> = {},
  operationId: string = crypto.randomUUID(),
) {
  const renew = await renewOn.post("renew", {
    ...scope,
    instanceToken: token,
    operation: {
      kind: "call",
      invocationId: operationId,
      requestId: crypto.randomUUID(),
      params: { name: method, arguments: extra },
    },
  });
  if (renew.status !== 200) return renew;
  return sendOn.post(method, {
    ...scope,
    instanceToken: token,
    operationId,
    ...extra,
  });
}
const read = (on: Replica, token: string) => leg(on, on, token, "read");
async function openApp(on: Replica, token: string) {
  const response = await on.post("app/open", {
    ...scope,
    instanceToken: token,
    toolName: "reset",
  });
  expect(response.status).toBe(200);
  return (await response.json()).childToken as string;
}
/** A Settings App's tool call: its own `/renew`, then the call. */
async function callApp(
  renewOn: Replica,
  sendOn: Replica,
  token: string,
  childToken: string,
  operationId: string = crypto.randomUUID(),
) {
  const params = { name: "reset", arguments: {} };
  const renew = await renewOn.post("renew", {
    ...scope,
    instanceToken: token,
    operation: {
      kind: "call",
      invocationId: operationId,
      requestId: crypto.randomUUID(),
      params: { name: "app/call", arguments: { childToken, params } },
    },
  });
  if (renew.status !== 200) return renew;
  return sendOn.post("app/call", {
    ...scope,
    instanceToken: token,
    childToken,
    operationId,
    params,
  });
}

beforeEach(() => {
  shared.store = undefined;
  shared.tools = undefined;
  shared.receipts.clear();
  shared.storeDown = false;
  shared.refuseSettingsWrites = false;
  shared.catalogHold = undefined;
  hold = undefined;
  Object.assign(plugin, {
    values: { ...settingsFixture().values },
    reads: 0,
    updates: 0,
    resets: 0,
  });
  shared.call = async (params) => {
    if (params.name === "read") {
      plugin.reads++;
      return {
        content: [],
        structuredContent: { ...settingsFixture(), values: { ...plugin.values } },
      };
    }
    if (params.name === "save") {
      plugin.updates++;
      await hold?.();
      Object.assign(plugin.values, params.arguments?.set);
      return { content: [], structuredContent: { values: { ...plugin.values } } };
    }
    if (params.name === "reset") plugin.resets++;
    return { content: [] };
  };
});
afterEach(() => {
  vi.useRealTimers();
});

describe("Settings across replicas", () => {
  it("saves on a replica that never read, and replays a retry on a third without calling the plugin again", async () => {
    const [a, b, c] = await replicas(3);
    const token = await open(a);
    expect((await read(a, token)).status).toBe(200);
    const id = crypto.randomUUID();
    const saved = await leg(b, b, token, "update", { set: { count: 5 } }, id);
    expect(saved.status).toBe(200);
    const first = await saved.json();
    const retried = await leg(c, c, token, "update", { set: { count: 5 } }, id);
    expect(retried.status).toBe(200);
    expect(await retried.json()).toEqual(first);
    expect(plugin.updates).toBe(1);
    // Reopening on any replica shows what the plugin now holds.
    expect(await open(c)).toBe(token);
    const reread = await read(c, token);
    expect(reread.status).toBe(200);
    expect((await reread.json()).result.structuredContent.values.count).toBe(5);
    expect((await a.post("actions", { ...scope, instanceToken: token })).status).toBe(200);
  });

  it("splits a save's preflight and the save itself across replicas", async () => {
    const [a, b, c] = await replicas(3);
    const token = await open(a);
    expect((await read(a, token)).status).toBe(200);
    const saved = await leg(b, c, token, "update", { set: { label: "split" } });
    expect(saved.status).toBe(200);
    expect(plugin.values.label).toBe("split");
  });

  it("reads on one replica, then saves on another and back again with no refusal", async () => {
    const [a, b] = await replicas(2);
    const token = await open(a);
    expect((await read(a, token)).status).toBe(200);
    expect((await leg(b, b, token, "update", { set: { count: 3 } })).status).toBe(200);
    expect((await leg(a, a, token, "update", { set: { count: 4 } })).status).toBe(200);
    expect(plugin.updates).toBe(2);
    expect(plugin.values.count).toBe(4);
  });

  it("sends two saves at once to the plugin, each answered with its own result", async () => {
    const [a, b] = await replicas(2);
    const token = await open(a);
    expect((await read(a, token)).status).toBe(200);
    const [first, second] = await Promise.all([
      leg(a, a, token, "update", { set: { label: "one" } }),
      leg(b, b, token, "update", { set: { count: 7 } }),
    ]);
    expect([first.status, second.status]).toEqual([200, 200]);
    expect(plugin.updates).toBe(2);
    const reread = await read(b, token);
    expect((await reread.json()).result.structuredContent.values).toMatchObject({
      label: "one",
      count: 7,
    });
  });

  it("refuses a save once the Settings session's lease has ended", async () => {
    const [a, b] = await replicas(2);
    const token = await open(a);
    expect((await read(a, token)).status).toBe(200);
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(Date.now() + 31 * 60_000);
    const refused = await leg(b, b, token, "update", { set: { count: 1 } });
    expect(refused.status).toBe(403);
    expect((await refused.json()).code).toBe("INSTANCE_UNAVAILABLE");
    expect(plugin.updates).toBe(0);
  });

  it("refuses a save on another replica after Settings closes", async () => {
    const [a, b] = await replicas(2);
    const token = await open(a);
    expect((await read(a, token)).status).toBe(200);
    expect((await a.post("close", { ...scope, instanceToken: token })).status).toBe(200);
    const refused = await leg(b, b, token, "update", { set: { count: 1 } });
    expect(refused.status).toBe(403);
    expect((await refused.json()).code).toBe("INSTANCE_UNAVAILABLE");
    expect(plugin.updates).toBe(0);
  });

  it("reports a save whose replica died after dispatch as unknown, and never sends it again", async () => {
    const [a, b, c] = await replicas(3);
    const token = await open(a);
    expect((await read(a, token)).status).toBe(200);
    let release!: () => void;
    hold = () => new Promise<void>((resolve) => (release = resolve));
    const id = crypto.randomUUID();
    // Replica B sends the save and never answers.
    const lost = leg(b, b, token, "update", { set: { count: 9 } }, id);
    await vi.waitFor(() => expect(plugin.updates).toBe(1));
    const retried = await leg(c, c, token, "update", { set: { count: 9 } }, id);
    expect(retried.status).toBe(403);
    expect(await retried.json()).toMatchObject({
      code: "INVOCATION_OUTCOME_UNKNOWN",
      outcomeUnknown: true,
    });
    expect(plugin.updates).toBe(1);
    hold = undefined;
    release();
    await lost;
  });

  it("refuses a save, and calls nothing, while the store can't be reached", async () => {
    const [a, b] = await replicas(2);
    const token = await open(a);
    expect((await read(a, token)).status).toBe(200);
    shared.storeDown = true;
    const refused = await leg(b, b, token, "update", { set: { count: 1 } });
    expect(refused.status).toBe(403);
    expect((await refused.json()).code).toBe("INSTANCE_STORE_UNAVAILABLE");
    expect(plugin.updates).toBe(0);
  });

  it("fails a read whose document can't be kept, so no later save is refused for it", async () => {
    const [a] = await replicas(1);
    const token = await open(a);
    shared.refuseSettingsWrites = true;
    const refused = await read(a, token);
    expect(refused.status).toBe(403);
    expect((await refused.json()).code).toBe("INSTANCE_STORE_UNAVAILABLE");
    expect(plugin.reads).toBe(1);
  });

  it.each([
    { kept: "the same document", changed: false },
    { kept: "a different document", changed: true },
  ])(
    "lets a read that stores second stand only when both kept $kept",
    async ({ changed }) => {
      const [a, b] = await replicas(2);
      const token = await open(a);
      let reached!: () => void;
      let release: (() => void) | undefined;
      const holding = new Promise<void>((resolve) => (reached = resolve));
      const call = shared.call;
      shared.call = async (params) => {
        if (params.name === "read" && !release) {
          const released = new Promise<void>((resolve) => (release = resolve));
          reached();
          await released;
          if (changed) plugin.values = { ...plugin.values, label: "late" };
        }
        return call(params);
      };
      const slow = read(a, token);
      await holding;
      expect((await read(b, token)).status).toBe(200);
      release!();
      const late = await slow;
      expect(late.status).toBe(changed ? 403 : 200);
      if (changed)
        expect((await late.json()).code).toBe("SETTINGS_CONTROL_CONFLICT");
      // The document the first read kept is still the one stored.
      const { createPluginInstanceControlPort } = await import(
        "../../../services/plugin-host/instance-store.js"
      );
      const stored = await createPluginInstanceControlPort(
        {
          actorId: "actor",
          projectId: "project",
          workspaceId: "workspace",
          subject: "verified-subject",
        },
        { env: {}, hosted: false },
      )!.read(token, AbortSignal.timeout(5000));
      expect(JSON.parse(stored!.settingsJson!).document.values.label).toBe("");
    },
  );
});

describe("Settings Apps across replicas", () => {
  it("opens a Settings App on one replica, calls it on another, and replays a retry on a third", async () => {
    const [a, b, c] = await replicas(3);
    const token = await open(a);
    expect((await read(a, token)).status).toBe(200);
    const app = await openApp(a, token);
    const id = crypto.randomUUID();
    const called = await callApp(b, b, token, app, id);
    expect(called.status).toBe(200);
    const first = await called.json();
    const retried = await callApp(c, c, token, app, id);
    expect(retried.status).toBe(200);
    expect(await retried.json()).toEqual(first);
    expect(plugin.resets).toBe(1);
  });

  it("ends a Settings App on every replica once it closes on one", async () => {
    const [a, b, c] = await replicas(3);
    const token = await open(a);
    expect((await read(a, token)).status).toBe(200);
    const app = await openApp(a, token);
    expect(
      (await b.post("app/close", { ...scope, instanceToken: token, childToken: app }))
        .status,
    ).toBe(200);
    const refused = await callApp(c, c, token, app);
    expect(refused.status).toBe(403);
    expect((await refused.json()).code).toBe("INSTANCE_UNAVAILABLE");
    expect(plugin.resets).toBe(0);
  });

  it("ends a Settings App when its Settings closes on another replica", async () => {
    const [a, b, c] = await replicas(3);
    const token = await open(a);
    expect((await read(a, token)).status).toBe(200);
    const app = await openApp(a, token);
    expect((await b.post("close", { ...scope, instanceToken: token })).status).toBe(200);
    const refused = await callApp(c, c, token, app);
    expect(refused.status).toBe(403);
    expect(plugin.resets).toBe(0);
  });

  it("refuses a Settings App call after the server changes the App's action", async () => {
    const [a, b] = await replicas(2);
    const token = await open(a);
    expect((await read(a, token)).status).toBe(200);
    const app = await openApp(a, token);
    shared.tools = (current) => ({
      ...current,
      tools: current.tools.map((tool) =>
        tool.name === "reset" ? { ...tool, description: "Reset changed" } : tool,
      ),
    });
    const refused = await callApp(b, b, token, app);
    expect(refused.status).toBe(403);
    expect(plugin.resets).toBe(0);
  });

  it("refuses a call that was still loading when its App closed on another replica", async () => {
    const [a, b] = await replicas(2);
    const token = await open(a);
    expect((await read(a, token)).status).toBe(200);
    const app = await openApp(a, token);
    let reached!: () => void;
    let release!: () => void;
    const holding = new Promise<void>((resolve) => (reached = resolve));
    shared.catalogHold = () => {
      shared.catalogHold = undefined;
      reached();
      return new Promise<void>((resolve) => (release = resolve));
    };
    const call = callApp(b, b, token, app);
    await holding;
    expect(
      (await a.post("app/close", { ...scope, instanceToken: token, childToken: app }))
        .status,
    ).toBe(200);
    release();
    const refused = await call;
    expect(refused.status).toBe(403);
    expect((await refused.json()).code).toBe("INSTANCE_UNAVAILABLE");
    expect(plugin.resets).toBe(0);
  });

  it("closes only its own Settings Apps, never another row the user holds", async () => {
    const [a, b] = await replicas(2);
    const token = await open(a);
    expect((await read(a, token)).status).toBe(200);
    const app = await openApp(a, token);
    // The Settings App's own token, sent as if it were one of its Apps.
    const refused = await b.post("app/close", {
      ...scope,
      instanceToken: token,
      childToken: token,
    });
    expect(refused.status).toBe(403);
    expect((await refused.json()).code).toBe("INSTANCE_DENIED");
    expect((await read(b, token)).status).toBe(200);
    expect((await callApp(b, b, token, app)).status).toBe(200);
    expect(plugin.resets).toBe(1);
  });
});
