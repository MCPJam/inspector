import { Hono } from "hono";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PLUGIN_MODEL_APP_META } from "../../../../shared/plugin-model-app";

/**
 * Production runs several replicas with no sticky sessions, so a model App
 * is published by the replica that ran the model call and then opened,
 * called, renewed and closed on any of them. Each "replica" here is a fresh
 * module graph with its own model App registry and route state. What real
 * replicas share is shared here too:
 * - one control store, kept by the local store under the backend's rules;
 * - one receipt journal, modelled on the invoker's rules: a completed call
 *   replays its value, and a dispatched one whose replica died is an unknown
 *   outcome that never runs again;
 * - one receipt store for current-chat message bindings.
 * The error module is shared as well, so a refusal raised in one graph is
 * still recognised in another.
 */
const shared = vi.hoisted(() => ({
  store: undefined as unknown,
  invocation: undefined as unknown,
  receipts: new Map<
    string,
    { state: "dispatched" | "completed"; body?: unknown }
  >(),
  messages: new Map<string, string>(),
  calls: 0,
  revision: "draw-v1",
  storeDown: false,
  /** Context writes waiting at the store, while `holdContext` is set. */
  contextWrites: [] as (() => void)[],
  holdContext: false,
  /** Holds a call's catalog read, as a cold connection would. */
  catalogHold: undefined as undefined | (() => Promise<void>),
  hold: undefined as undefined | (() => Promise<void>),
}));
vi.mock("../../../services/plugin-host/invocation.js", async (original) => {
  shared.invocation ??= await original();
  return shared.invocation as object;
});
vi.mock("../../../services/plugin-host/local-store.js", async (original) => {
  const actual =
    await original<
      typeof import("../../../services/plugin-host/local-store.js")
    >();
  shared.store ??= new actual.LocalPluginControlStore();
  const store = shared.store as InstanceType<
    typeof actual.LocalPluginControlStore
  >;
  const { PluginInvocationError } =
    await import("../../../services/plugin-host/invocation.js");
  return {
    ...actual,
    localPluginControls: {
      handler: (path: string, unavailable: string) => {
        const handle = store.handler(path, unavailable);
        return async (body: unknown, signal: AbortSignal) => {
          if (shared.storeDown) throw new PluginInvocationError(unavailable);
          if (
            (body as { action?: string }).action === "context" &&
            shared.holdContext
          )
            await new Promise<void>((resolve) =>
              shared.contextWrites.push(resolve),
            );
          return handle(body, signal);
        };
      },
    },
  };
});
vi.mock("../../../services/plugin-host/receipt-store.js", async (original) => {
  const actual =
    await original<
      typeof import("../../../services/plugin-host/receipt-store.js")
    >();
  const { PluginInvocationError } =
    await import("../../../services/plugin-host/invocation.js");
  return {
    ...actual,
    // Only message bindings reach this port here; calls use the journal below.
    createPluginInvocationReceiptPort: (owner: { instanceId: string }) => ({
      claim: async (id: string, input: { fingerprint: string }) => {
        const key = `${owner.instanceId}|${id}`;
        const saved = shared.messages.get(key);
        if (saved && saved !== input.fingerprint)
          throw new PluginInvocationError("INVOCATION_ID_REUSED");
        shared.messages.set(key, input.fingerprint);
        return { claimed: !saved, receipt: {} };
      },
    }),
  };
});
vi.mock("../../../utils/widget-resource-content.js", () => ({
  widgetResourceContent: () => ({
    html: "<p>drawing</p>",
    mimeTypeValid: true,
  }),
}));
vi.mock("../../../utils/ui-resource-meta.js", () => ({
  canSkipListingLookup: () => true,
  findListingMetaForUri: async () => undefined,
}));
vi.mock("../../../services/plugin-host/request-runtime.js", () => {
  const meta = {
    ui: { resourceUri: "ui://draw", visibility: ["model", "app"] },
  };
  const tool = (name: string) => ({
    revision: name === "draw" ? shared.revision : `${name}-v1`,
    appToolsEnabled: true,
    resourcesEnabled: true,
    contextEnabled: true,
    tool: { name, _meta: meta },
    manager: {
      readResource: async () => ({
        contents: [
          {
            uri: "ui://draw",
            mimeType: "text/html;profile=mcp-app",
            text: "<p>drawing</p>",
          },
        ],
      }),
      getServerConfig: () => ({}),
    },
  });
  type Read = <T>(query: () => Promise<T>) => Promise<T>;
  // Each resolution makes its admission read through the caller's fence, as
  // the real runtime does, and holds when a test holds the catalog.
  const admitted = async (read: Read = (query) => query()) => {
    await shared.catalogHold?.();
    await read(async () => undefined);
  };
  return {
    createPluginRequestRuntime: () => ({
      resolve: async (name: string, _signal: AbortSignal, read?: Read) => {
        await admitted(read);
        return tool(name);
      },
      resolveTools: async (
        names: string[],
        _signal: AbortSignal,
        read?: Read,
      ) => {
        await admitted(read);
        return new Map(names.map((name) => [name, tool(name)]));
      },
      release: async () => undefined,
    }),
    assertPluginInstanceBindingCurrent: async () => undefined,
  };
});
vi.mock("../../../services/plugin-host/request-invocation.js", async () => {
  const { PluginInvocationError } =
    await import("../../../services/plugin-host/invocation.js");
  return {
    invokePluginRequest: async (
      c: { json: (body: unknown) => Response; req: { raw: Request } },
      input: {
        invocationId: string;
        params: { name: string };
        resolve: (name: string, signal: AbortSignal) => Promise<unknown>;
        assertLive: () => void;
        assertOrigin: (resolved: unknown) => void;
        runtime: { release: () => Promise<void> };
      },
    ) => {
      try {
        const receipt = shared.receipts.get(input.invocationId);
        if (receipt?.state === "completed") return c.json(receipt.body);
        if (receipt?.state === "dispatched")
          throw new PluginInvocationError("INVOCATION_OUTCOME_UNKNOWN", true);
        const resolved = await input.resolve(
          input.params.name,
          c.req.raw.signal,
        );
        input.assertLive();
        input.assertOrigin(resolved);
        shared.receipts.set(input.invocationId, { state: "dispatched" });
        shared.calls++;
        await shared.hold?.();
        const body = {
          status: "completed",
          result: { content: [{ type: "text", text: "drawn" }] },
        };
        shared.receipts.set(input.invocationId, { state: "completed", body });
        return c.json(body);
      } finally {
        await input.runtime.release();
      }
    },
  };
});

const actor = {
  actorId: "actor",
  projectId: "project",
  workspaceId: "workspace",
  subject: "verified-subject",
};
const scope = {
  projectId: "project",
  pluginWorkspace: { version: 1, workspaceId: "workspace" },
};
const source = {
  owner: {
    actorId: "actor",
    projectId: "project",
    workspaceId: "workspace",
    instanceId: "f".repeat(64),
    generation: 1 as const,
    serverId: "excalidraw",
    bindingId: "binding",
    placement: "interactive" as const,
  },
  subject: "verified-subject",
  hostId: "host",
  hostRevision: "host-v1",
  serverIdentity: { kind: "standalone" as const, serverId: "excalidraw" },
};

type Replica = {
  post: (path: string, body: unknown, as?: typeof actor) => Promise<Response>;
  modelApps: typeof import("../../../services/plugin-host/model-apps.js").modelApps;
};
async function replica(): Promise<Replica> {
  vi.resetModules();
  const { pluginModelAppRoutes } = await import("../plugin-model-apps");
  const { modelApps } =
    await import("../../../services/plugin-host/model-apps.js");
  let visitor = actor;
  const app = new Hono().route(
    "/model",
    pluginModelAppRoutes({
      route: async (_c, action) => {
        try {
          return await action();
        } catch (error) {
          const { code, outcomeUnknown } = error as {
            code?: string;
            outcomeUnknown?: boolean;
          };
          return Response.json(
            { code: code ?? "ERROR" },
            { status: outcomeUnknown ? 409 : 403 },
          );
        }
      },
      admitted: async () => ({
        actor: visitor,
        bearer: "fixture-bearer",
        admission: {
          actorId: visitor.actorId,
          projectId: visitor.projectId,
          workspaceId: visitor.workspaceId,
          revalidate: async () => undefined,
        } as never,
      }),
      cleanup: async () => visitor,
    }),
  );
  return {
    modelApps,
    post: async (path, body, as = actor) => {
      visitor = as;
      return app.request(`/model/${path}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      });
    },
  };
}
/** One at a time: a reset only isolates the import that follows it. */
async function replicas(count: number) {
  const created: Replica[] = [];
  for (let index = 0; index < count; index++) created.push(await replica());
  return created;
}
/** The completed model call's result, published by the replica that ran it. */
async function publish(on: Replica) {
  const result = (await on.modelApps.publish(
    { content: [{ type: "text", text: "A blue square" }] },
    source,
    "draw",
    shared.revision,
    { ui: { resourceUri: "ui://draw", visibility: ["model", "app"] } },
    new AbortController().signal,
  )) as {
    _meta: Record<string, { instanceToken?: string; unavailable?: true }>;
  };
  return result._meta[PLUGIN_MODEL_APP_META]!;
}
const handle = (token: string) => ({ ...scope, instanceToken: token });
const open = (on: Replica, token: string) => on.post("open", handle(token));
const call = (on: Replica, token: string, invocationId = crypto.randomUUID()) =>
  on.post("call", {
    ...handle(token),
    invocationId,
    params: { name: "draw", arguments: { shape: "square" } },
  });
const update = (on: Replica, token: string, sequence: number, text: string) =>
  on.post("context", {
    ...handle(token),
    operationId: crypto.randomUUID(),
    sequence,
    params: { content: [{ type: "text", text }] },
  });
const readContext = async (on: Replica, token: string) =>
  (await on.post("context/read", handle(token))).json();

beforeEach(() => {
  shared.store = undefined;
  shared.receipts.clear();
  shared.messages.clear();
  shared.calls = 0;
  shared.revision = "draw-v1";
  shared.storeDown = false;
  shared.contextWrites = [];
  shared.holdContext = false;
  shared.catalogHold = undefined;
  shared.hold = undefined;
});
afterEach(() => vi.useRealTimers());

describe("model Apps across replicas", () => {
  it("creates on A, opens on B, calls on C, and replays a retried call on A without drawing again", async () => {
    const [a, b, c] = await replicas(3);
    const { instanceToken: token } = await publish(a);
    // The reported failure: the same open, repeated, on every replica.
    const opens = await Promise.all(
      Array.from({ length: 10 }, (_, index) =>
        open([a, b, c][index % 3]!, token!),
      ),
    );
    expect(opens.map((response) => response.status)).toEqual(
      Array(10).fill(200),
    );
    const bodies = await Promise.all(opens.map((response) => response.json()));
    expect(new Set(bodies.map((body) => body.instanceId)).size).toBe(1);
    expect(bodies[0].widgetContent.html).toBe("<p>drawing</p>");
    const id = crypto.randomUUID();
    const first = await call(c, token!, id);
    expect(first.status).toBe(200);
    const retried = await call(a, token!, id);
    expect(await retried.json()).toEqual(await first.json());
    expect(shared.calls).toBe(1);
  });

  it("restores a live App in a replaced process, but never a closed or expired one", async () => {
    const [a] = await replicas(1);
    const live = (await publish(a)).instanceToken!;
    const closed = (await publish(a)).instanceToken!;
    expect((await a.post("close", handle(closed))).status).toBe(200);
    const [restarted] = await replicas(1);
    expect((await open(restarted!, live)).status).toBe(200);
    const refused = await open(restarted!, closed);
    expect(refused.status).toBe(403);
    expect((await refused.json()).code).toBe("MODEL_APP_UNAVAILABLE");
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(Date.now() + 31 * 60_000);
    const [later] = await replicas(1);
    expect((await open(later!, live)).status).toBe(403);
  });

  it("keeps one context version across replicas: written on A, read on B, removed on C", async () => {
    const [a, b, c] = await replicas(3);
    const token = (await publish(a)).instanceToken!;
    expect((await update(a, token, 1, "Blue square")).status).toBe(200);
    const read = await readContext(b, token);
    expect(read.state.content[0].text).toBe("Blue square");
    const removed = await c.post("context/remove-all", {
      ...handle(token),
      operationId: crypto.randomUUID(),
      basis: read.cursor ?? 0,
    });
    expect(await removed.json()).toMatchObject({
      outcome: "applied",
      snapshot: { state: null },
    });
    expect((await readContext(a, token)).state).toBeNull();
  });

  it("commits an App's update and the person's removal, racing on two replicas, one on top of the other", async () => {
    const [a, b, c] = await replicas(3);
    const token = (await publish(a)).instanceToken!;
    // Both replicas prepare their write on the same stored version.
    shared.holdContext = true;
    const updated = update(b, token, 1, "From B");
    await vi.waitFor(() => expect(shared.contextWrites).toHaveLength(1));
    const removed = c.post("context/remove-all", {
      ...handle(token),
      operationId: crypto.randomUUID(),
      basis: 0,
    });
    await vi.waitFor(() => expect(shared.contextWrites).toHaveLength(2));
    shared.holdContext = false;
    shared.contextWrites[0]!();
    expect((await updated).status).toBe(200);
    // C's write now conflicts, and commits on top of B's instead of over it.
    shared.contextWrites[1]!();
    const removal = await removed;
    expect(removal.status).toBe(200);
    expect(await removal.json()).toMatchObject({ outcome: "applied" });
    // Two committed versions: neither write was lost.
    expect(await readContext(a, token)).toMatchObject({
      revision: 2,
      state: null,
    });
  });

  it("renews on B past the original deadline, and A and C still serve the App", async () => {
    const [a, b, c] = await replicas(3);
    const token = (await publish(a)).instanceToken!;
    expect((await open(a, token)).status).toBe(200);
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(Date.now() + 25 * 60_000);
    const renewed = await b.post("renew", handle(token));
    expect(await renewed.json()).toMatchObject({ status: "renewed" });
    vi.setSystemTime(Date.now() + 10 * 60_000);
    expect((await open(a, token)).status).toBe(200);
    expect((await call(c, token)).status).toBe(200);
  });

  it("ends the App on every replica once it closes on one, and a renewal cannot revive it", async () => {
    const [a, b, c] = await replicas(3);
    const token = (await publish(a)).instanceToken!;
    expect((await open(b, token)).status).toBe(200);
    expect((await a.post("close", handle(token))).status).toBe(200);
    for (const response of [
      await open(b, token),
      await call(c, token),
      await update(b, token, 1, "late"),
      await b.post("renew", handle(token)),
    ]) {
      expect(response.status).toBe(403);
      expect((await response.json()).code).toBe("MODEL_APP_UNAVAILABLE");
    }
    expect(shared.calls).toBe(0);
  });

  it("refuses a call still authorizing on B when the App closes on A", async () => {
    const [a, b] = await replicas(2);
    const token = (await publish(a)).instanceToken!;
    expect((await open(b, token)).status).toBe(200);
    let release!: () => void;
    const held = new Promise<void>((resolve) => (release = resolve));
    let waiting!: () => void;
    const reached = new Promise<void>((resolve) => (waiting = resolve));
    shared.catalogHold = async () => {
      waiting();
      await held;
    };
    const pending = call(b, token);
    await reached;
    shared.catalogHold = undefined;
    expect((await a.post("close", handle(token))).status).toBe(200);
    release();
    const refused = await pending;
    expect(refused.status).toBe(403);
    expect(shared.calls).toBe(0);
  });

  it("reports a call whose replica died after dispatch as unknown, and never draws again", async () => {
    const [a, b, c] = await replicas(3);
    const token = (await publish(a)).instanceToken!;
    let release!: () => void;
    shared.hold = () => new Promise<void>((resolve) => (release = resolve));
    const id = crypto.randomUUID();
    const lost = call(b, token, id);
    await vi.waitFor(() => expect(shared.calls).toBe(1));
    const retried = await call(c, token, id);
    expect(retried.status).toBe(409);
    expect((await retried.json()).code).toBe("INVOCATION_OUTCOME_UNKNOWN");
    expect(shared.calls).toBe(1);
    shared.hold = undefined;
    release();
    await lost;
  });

  it("withholds the App and calls nothing while the store can't be reached", async () => {
    const [a, b] = await replicas(2);
    const token = (await publish(a)).instanceToken!;
    shared.storeDown = true;
    expect(await publish(a)).toEqual({ unavailable: true });
    const refused = await call(b, token);
    expect(refused.status).toBe(403);
    expect((await refused.json()).code).toBe("INSTANCE_STORE_UNAVAILABLE");
    expect(shared.calls).toBe(0);
    shared.storeDown = false;
    expect((await open(b, token)).status).toBe(200);
  });

  it.each([
    ["another user", { ...actor, actorId: "other" }],
    ["another credential subject", { ...actor, subject: "other" }],
    ["another workspace", { ...actor, workspaceId: "other" }],
  ])(
    "refuses %s on any replica without ending the owner's App",
    async (_label, other) => {
      const [a, b] = await replicas(2);
      const token = (await publish(a)).instanceToken!;
      expect((await b.post("open", handle(token), other)).status).toBe(403);
      expect((await b.post("close", handle(token), other)).status).toBe(200);
      expect((await open(b, token)).status).toBe(200);
      expect((await open(a, token)).status).toBe(200);
    },
  );

  it("refuses the App once its tool changes revision", async () => {
    const [a, b] = await replicas(2);
    const token = (await publish(a)).instanceToken!;
    shared.revision = "draw-v2";
    expect((await open(b, token)).status).toBe(403);
    expect((await call(b, token)).status).toBe(403);
    expect(shared.calls).toBe(0);
  });

  it("binds a current-chat message operation to one payload across replicas", async () => {
    const [a, b] = await replicas(2);
    const token = (await publish(a)).instanceToken!;
    const signal = new AbortController().signal;
    const onA = await a.modelApps.restore(token, actor, signal);
    await a.modelApps.prepareMessage(
      onA,
      actor,
      "message-1",
      "a".repeat(64),
      signal,
    );
    const onB = await b.modelApps.restore(token, actor, signal);
    // The same payload again is a retry; different content is refused.
    await b.modelApps.prepareMessage(
      onB,
      actor,
      "message-1",
      "a".repeat(64),
      signal,
    );
    await expect(
      b.modelApps.prepareMessage(
        onB,
        actor,
        "message-1",
        "b".repeat(64),
        signal,
      ),
    ).rejects.toMatchObject({ code: "INSTANCE_MESSAGE_CHANGED" });
  });
});
