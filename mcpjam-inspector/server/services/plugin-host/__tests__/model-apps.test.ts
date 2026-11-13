import { afterEach, describe, it, expect, vi } from "vitest";
import { z } from "zod";
import { PluginInvocationError } from "../invocation.js";
import { ModelAppRegistry } from "../model-apps.js";
import { PluginContextMemory } from "../context-memory.js";
import { PLUGIN_MODEL_APP_META } from "../../../../shared/plugin-model-app.js";
import { pluginInstances, type PluginFormOwner } from "../instances.js";
import { RequestOwnedToolInvoker } from "../request-invoker.js";
import {
  createPluginInstanceControlPort,
  type PluginInstanceControlPort,
} from "../instance-store.js";

afterEach(() => vi.useRealTimers());
const owner = {
  owner: {
    actorId: "a",
    projectId: "p",
    workspaceId: "w",
    instanceId: "original",
    generation: 1,
    serverId: "saved-id",
    bindingId: "binding",
    placement: "interactive",
  },
  subject: "subject",
  hostId: "host",
  hostRevision: "rev",
  serverIdentity: { kind: "standalone", serverId: "saved-id" },
} as PluginFormOwner;
const actor = {
  actorId: "a",
  projectId: "p",
  workspaceId: "w",
  subject: "subject",
};
const meta = { ui: { resourceUri: "ui://app" } };
const signal = () => new AbortController().signal;
const markerSchema = z.object({
  content: z.array(z.unknown()),
  _meta: z.object({
    [PLUGIN_MODEL_APP_META]: z.object({ instanceToken: z.string() }),
  }),
});
async function publish(registry: ModelAppRegistry, toolName = "pickFile") {
  const result = markerSchema.parse(
    await registry.publish(
      { content: [] },
      owner,
      toolName,
      "tool-rev",
      meta,
      signal(),
    ),
  );
  return result._meta[PLUGIN_MODEL_APP_META].instanceToken;
}
function publication(registry: ModelAppRegistry) {
  const invoker = new RequestOwnedToolInvoker(owner.owner, () => {});
  const invoke = async () =>
    markerSchema.parse(
      await invoker.invoke(
        {
          authorize: async () => ({
            owner: owner.owner,
            revision: "tool-rev",
            enabled: true,
            tool: { name: "pickFile" },
            allowedOrigins: ["model"],
            requiresApproval: false,
          }),
          approve: async () => false,
          admit: async () => {},
          execute: async (_auth, _next, current) =>
            registry.publish(
              { content: [] },
              owner,
              "pickFile",
              "tool-rev",
              meta,
              current,
            ),
          classifyFailure: () => "unknown",
        },
        "model",
        "original-call",
        { name: "pickFile" },
      ),
    );
  return { invoke, close: () => invoker.close() };
}
const update = (
  registry: ModelAppRegistry,
  token: string,
  request: {
    operationId: string;
    sequence: number;
    params: unknown;
    attach?: "user";
  },
  limits?: { updateMaxBytes: number; maxBlocks: number },
) =>
  registry
    .restore(token, actor, signal())
    .then(() =>
      registry.changeContext(
        token,
        actor,
        { kind: "update", request: request as never, limits: limits as never },
        signal(),
      ),
    )
    .then((changed) => changed.result);
const removeAll = (registry: ModelAppRegistry, token: string, basis = 0) =>
  registry
    .restore(token, actor, signal())
    .then(() =>
      registry.changeContext(
        token,
        actor,
        { kind: "remove-all", request: { operationId: "remove", basis } },
        signal(),
      ),
    );
const text = (sequence: number, value: string, attach = sequence > 1) => ({
  operationId: `op-${sequence}`,
  sequence,
  params: { content: [{ type: "text", text: value }] },
  // After its context is removed, the person uses the App again.
  ...(attach ? { attach: "user" as const } : {}),
});

describe("trusted completed model App ownership", () => {
  it("counts an open model App's context against this process's memory", async () => {
    const registry = new ModelAppRegistry(
      60_000,
      new PluginContextMemory(64 * 1024, 1024 * 1024),
    );
    const first = await publish(registry, "first");
    const second = await publish(registry, "second");
    await update(registry, first, text(1, "x".repeat(40_000)));
    await expect(
      update(registry, second, text(1, "y".repeat(30_000))),
    ).rejects.toThrow("PLUGIN_CONTEXT_MEMORY_LIMIT");
    // Removing the first App's context frees its bytes, and so does closing.
    await removeAll(registry, first);
    await update(registry, second, text(1, "y".repeat(30_000)));
    await expect(
      update(registry, first, text(2, "x".repeat(40_000))),
    ).rejects.toThrow("PLUGIN_CONTEXT_MEMORY_LIMIT");
    await registry.close(second, actor, signal());
    await update(registry, first, text(2, "x".repeat(40_000)));
  });
  it("acknowledges a retried update after removal without checking or charging memory", async () => {
    const registry = new ModelAppRegistry(
      60_000,
      new PluginContextMemory(64 * 1024, 1024 * 1024),
    );
    const first = await publish(registry, "first");
    const second = await publish(registry, "second");
    const request = text(1, "x".repeat(40_000));
    const applied = await update(registry, first, request);
    await removeAll(registry, first);
    // The retry gets the original update back, and the context stays removed.
    expect(await update(registry, first, request)).toEqual(applied);
    const app = registry.get(first, actor);
    expect(
      app.context.snapshot(app.owner.owner.instanceId, 1).state,
    ).toBeNull();
    // It charged nothing, so the second App still has the whole budget...
    await update(registry, second, text(1, "y".repeat(60_000), false));
    // ...and with that budget spent, the retry is still not refused.
    expect(await update(registry, first, request)).toEqual(applied);
  });

  it("answers a retry under the client's policy, not the default limits", async () => {
    const registry = new ModelAppRegistry(60_000);
    const token = await publish(registry);
    // 300 KiB: over the 256 KiB default, within this client's policy.
    const limits = { updateMaxBytes: 1024 * 1024, maxBlocks: 64 };
    const request = {
      ...text(1, "x".repeat(300 * 1024)),
      operationId: "large",
    };
    const applied = await update(registry, token, request, limits);
    await removeAll(registry, token);
    expect(await update(registry, token, request, limits)).toEqual(applied);
  });

  it("keeps the App's form owner while it is restored, and withdraws it on close", async () => {
    const registry = new ModelAppRegistry();
    const token = await publish(registry);
    const app = await registry.restore(token, actor, signal());
    const source = app.owner.owner;
    expect(pluginInstances.getFormOwner(source, actor).owner).toEqual(source);
    expect(() =>
      pluginInstances.getFormOwner(source, { ...actor, subject: "other" }),
    ).toThrow();
    await registry.close(token, actor, signal());
    expect(() => pluginInstances.getFormOwner(source, actor)).toThrow();
  });
  it("renews a model App past its original lifetime, then lets it expire", async () => {
    vi.useFakeTimers();
    const registry = new ModelAppRegistry(100_000);
    const token = await publish(registry);
    const before = (await registry.restore(token, actor, signal())).owner.owner
      .instanceId;
    vi.advanceTimersByTime(80_000);
    expect(
      await registry.renew(token, actor, signal(), async () => undefined),
    ).toMatchObject({ renewed: true });
    vi.advanceTimersByTime(80_000);
    expect(
      (await registry.restore(token, actor, signal())).owner.owner.instanceId,
    ).toBe(before);
    vi.advanceTimersByTime(100_001);
    await expect(registry.restore(token, actor, signal())).rejects.toThrow(
      "MODEL_APP_UNAVAILABLE",
    );
    await expect(
      registry.renew(token, actor, signal(), async () => undefined),
    ).rejects.toThrow("MODEL_APP_UNAVAILABLE");
  });
  it("preserves result and deduplicates original completion through its receipt", async () => {
    const registry = new ModelAppRegistry();
    const operation = publication(registry);
    const first = await operation.invoke(),
      second = await operation.invoke();
    expect(first).toEqual(second);
    expect(first.content).toEqual([]);
    const handle = first._meta[PLUGIN_MODEL_APP_META];
    const entry = await registry.restore(handle.instanceToken, actor, signal());
    expect(entry.owner.owner.serverId).toBe("saved-id");
    expect(entry.owner.owner.instanceId).not.toBe("original");
    await registry.close(handle.instanceToken, actor, signal());
    operation.close();
  });
  it.each(["actorId", "projectId", "workspaceId", "subject"] as const)(
    "rejects changed %s",
    async (key) => {
      const registry = new ModelAppRegistry();
      const token = await publish(registry);
      await registry.restore(token, actor, signal());
      const other = { ...actor, [key]: "other" };
      await expect(registry.restore(token, other, signal())).rejects.toThrow(
        "MODEL_APP_UNAVAILABLE",
      );
      expect(() => registry.get(token, other)).toThrow();
      await expect(registry.close(token, other, signal())).rejects.toThrow();
      // The owner's App is untouched by the refused requests.
      await registry.restore(token, actor, signal());
      await registry.close(token, actor, signal());
    },
  );
  it("replays a closed completion's receipt without reviving the App", async () => {
    const registry = new ModelAppRegistry();
    const operation = publication(registry);
    const first = await operation.invoke();
    const token = first._meta[PLUGIN_MODEL_APP_META].instanceToken;
    await registry.close(token, actor, signal());
    expect(await operation.invoke()).toEqual(first);
    await expect(registry.restore(token, actor, signal())).rejects.toThrow();
    // Another process sees the same closed App.
    await expect(
      new ModelAppRegistry().restore(token, actor, signal()),
    ).rejects.toThrow("MODEL_APP_UNAVAILABLE");
    operation.close();
  });
  it("admits fresh Apps after more than 512 sequential closed publications", async () => {
    const registry = new ModelAppRegistry();
    const tokens = new Set<string>();
    for (let index = 0; index < 514; index++) {
      const token = await publish(registry, `tool-${index}`);
      expect(tokens.has(token)).toBe(false);
      tokens.add(token);
      await registry.restore(token, actor, signal());
      await registry.close(token, actor, signal());
      expect(() => registry.get(token, actor)).toThrow();
    }
  });
  it.each([
    ["the store is unavailable", () => undefined],
    [
      "the store refuses the App",
      () =>
        ({
          issue: async () => {
            throw new PluginInvocationError("INSTANCE_LIMIT");
          },
        }) as unknown as PluginInstanceControlPort,
    ],
  ])("retains a completed tool result when %s", async (_label, port) => {
    const result = {
      content: [{ type: "text", text: "The operation completed" }],
      structuredContent: { saved: true },
      _meta: { kept: true },
    };
    const registry = new ModelAppRegistry(60_000, undefined, undefined, port);
    expect(
      await registry.publish(result, owner, "tool", "rev", meta, signal()),
    ).toEqual({
      ...result,
      _meta: { kept: true, [PLUGIN_MODEL_APP_META]: { unavailable: true } },
    });
  });
  it("does not publish errors or non-App output", async () => {
    const registry = new ModelAppRegistry();
    const result = { isError: true, content: [] };
    expect(
      await registry.publish(result, owner, "tool", "rev", meta, signal()),
    ).toBe(result);
    const ordinary = { content: [] };
    expect(
      await registry.publish(ordinary, owner, "tool", "rev", {}, signal()),
    ).toBe(ordinary);
  });
  it("binds a current-chat message operation to one payload", async () => {
    const registry = new ModelAppRegistry();
    const token = await publish(registry);
    const app = await registry.restore(token, actor, signal());
    await registry.prepareMessage(app, actor, "m1", "digest", signal());
    await registry.prepareMessage(app, actor, "m1", "digest", signal());
    await expect(
      registry.prepareMessage(app, actor, "m1", "changed", signal()),
    ).rejects.toThrow("INSTANCE_MESSAGE_CHANGED");
    await registry.close(token, actor, signal());
  });
});

it("removes all of a model App's context, including what the chip doesn't show, and acknowledges a retry", async () => {
  const registry = new ModelAppRegistry();
  const token = await publish(registry);
  const { context, owner: source } = await registry.restore(
    token,
    actor,
    signal(),
  );
  const id = source.owner.instanceId;
  context.update(id, 1, {
    operationId: "mixed",
    sequence: 1,
    params: {
      content: [
        { type: "text", text: "Visible" },
        {
          type: "text",
          text: "Background",
          annotations: { audience: ["assistant"] },
        },
      ],
      structuredContent: { fixture: true },
    },
  });
  const request = { operationId: "remove-all", basis: 0 };
  const removed = context.removeAll(id, 1, request);
  expect(removed).toEqual({
    outcome: "applied",
    snapshot: {
      revision: 2,
      sequence: 1,
      state: null,
      held: true,
      cursor: 1,
      removedAt: 1,
      attachedAt: 0,
    },
  });
  // The same operation again: its receipt answers, nothing changes.
  expect(context.removeAll(id, 1, request)).toEqual(removed);
  expect(() =>
    context.removeAll(id, 1, { operationId: "remove-all", basis: 1 }),
  ).toThrow("INSTANCE_CONTEXT_DUPLICATE_MISMATCH");
  // The removal holds: the App's own update is refused; the person using the
  // App attaches again.
  const resend = {
    operationId: "resend",
    sequence: 2,
    params: { content: [{ type: "text", text: "Again" }] },
  };
  expect(() => context.update(id, 1, resend)).toThrow("INSTANCE_CONTEXT_HELD");
  expect(context.snapshot(id, 1).state).toBeNull();
  context.update(id, 1, { ...resend, attach: "user" });
  expect(context.snapshot(id, 1)).toMatchObject({
    cursor: 2,
    removedAt: 1,
    attachedAt: 2,
  });
  expect(context.snapshot(id, 1)).not.toHaveProperty("held");
  await registry.close(token, actor, signal());
});

describe("this process's copy of a durable model App", () => {
  it("keeps a renewed App when a reply from before the renewal arrives after its old deadline", async () => {
    vi.useFakeTimers();
    const registry = new ModelAppRegistry(100_000);
    const token = await publish(registry);
    await registry.restore(token, actor, signal());
    const stale = await createPluginInstanceControlPort(actor)!.read(
      token,
      signal(),
    );
    vi.advanceTimersByTime(80_000);
    await registry.renew(token, actor, signal(), async () => undefined);
    vi.advanceTimersByTime(30_000);
    // The stale reply refuses nothing and closes nothing.
    expect(
      registry.restoreFrom(token, actor, stale, signal()).expiresAt,
    ).toBeGreaterThan(Date.now());
    await registry.restore(token, actor, signal());
  });
  it("releases an idle App's context memory once its lease ends, without closing it", async () => {
    vi.useFakeTimers();
    const registry = new ModelAppRegistry(
      100_000,
      new PluginContextMemory(64 * 1024, 1024 * 1024),
    );
    const first = await publish(registry, "first");
    await update(registry, first, text(1, "x".repeat(40_000)));
    vi.advanceTimersByTime(100_001);
    expect(registry.holds(first)).toBe(false);
    const second = await publish(registry, "second");
    await update(registry, second, text(1, "y".repeat(40_000)));
  });
  it("counts concurrent updates of one actor's Apps against the budget together", async () => {
    const registry = new ModelAppRegistry(
      60_000,
      new PluginContextMemory(64 * 1024, 1024 * 1024),
    );
    const first = await publish(registry, "first");
    const second = await publish(registry, "second");
    const results = await Promise.allSettled([
      update(registry, first, text(1, "x".repeat(40_000))),
      update(registry, second, text(1, "y".repeat(40_000))),
    ]);
    expect(results.filter((result) => result.status === "rejected")).toEqual([
      expect.objectContaining({
        reason: expect.objectContaining({
          code: "PLUGIN_CONTEXT_MEMORY_LIMIT",
        }),
      }),
    ]);
  });
});

it("keeps one App's pending write reserved while a later write to it waits", async () => {
  const registry = new ModelAppRegistry(
    60_000,
    new PluginContextMemory(64 * 1024, 1024 * 1024),
  );
  const first = await publish(registry, "first");
  const second = await publish(registry, "second");
  await Promise.all([
    registry.restore(first, actor, signal()),
    registry.restore(second, actor, signal()),
  ]);
  const change = (token: string, request: ReturnType<typeof text>) =>
    registry.changeContext(
      token,
      actor,
      { kind: "update", request: request as never },
      signal(),
    );
  // A smaller second write to the same App must not replace the first
  // write's reservation and free budget for another App.
  const results = await Promise.allSettled([
    change(first, text(1, "x".repeat(40_000))),
    change(first, text(2, "x", false)),
    change(second, text(1, "y".repeat(40_000))),
  ]);
  expect(results.map((result) => result.status)).toEqual([
    "fulfilled",
    "fulfilled",
    "rejected",
  ]);
});
