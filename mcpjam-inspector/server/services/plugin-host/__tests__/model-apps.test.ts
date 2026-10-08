import { describe, it, expect, vi } from "vitest";
import { ModelAppRegistry } from "../model-apps.js";
import { PLUGIN_MODEL_APP_META } from "../../../../shared/plugin-model-app.js";
import type { PluginFormOwner } from "../instances.js";
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
function publish(registry: ModelAppRegistry) {
  return registry.publish(
    { content: [] },
    owner,
    "pickFile",
    "tool-rev",
    meta,
  ) as any;
}
describe("trusted completed model App ownership", () => {
  it("renews a retained model App past its original lifetime", () => {
    vi.useFakeTimers();
    try {
      const registry = new ModelAppRegistry(100);
      const token = publish(registry)._meta[PLUGIN_MODEL_APP_META]
        .instanceToken;
      const before = registry.get(token, actor).owner.owner.instanceId;
      vi.advanceTimersByTime(80);
      registry.renew(token, actor);
      vi.advanceTimersByTime(80);
      expect(registry.get(token, actor).owner.owner.instanceId).toBe(before);
      for (let i = 0; i < 2100; i++)
        registry.prepareMessage(token, actor, `m${i}`, "digest");
      vi.advanceTimersByTime(101);
      expect(() => registry.get(token, actor)).toThrow();
      expect(() => registry.renew(token, actor)).toThrow();
    } finally {
      vi.useRealTimers();
    }
  });
  it("preserves result and deduplicates original completion without executing a tool", () => {
    const registry = new ModelAppRegistry();
    const first = publish(registry),
      second = publish(registry);
    expect(first).toEqual(second);
    expect(first.content).toEqual([]);
    const handle = first._meta[PLUGIN_MODEL_APP_META];
    const entry = registry.get(handle.instanceToken, actor);
    expect(entry.owner.owner.serverId).toBe("saved-id");
    expect(entry.owner.owner.instanceId).not.toBe("original");
    registry.close(handle.instanceToken, actor);
  });
  it.each(["actorId", "projectId", "workspaceId", "subject"] as const)(
    "rejects changed %s",
    (key) => {
      const registry = new ModelAppRegistry();
      const token =
        publish(registry)._meta[PLUGIN_MODEL_APP_META].instanceToken;
      expect(() => registry.get(token, { ...actor, [key]: "other" })).toThrow();
      expect(() =>
        registry.close(token, { ...actor, [key]: "other" }),
      ).toThrow();
      registry.close(token, actor);
    },
  );
  it("keeps a closed completion tombstone so transcript retries never revive it", () => {
    const registry = new ModelAppRegistry();
    const first = publish(registry);
    const token = first._meta[PLUGIN_MODEL_APP_META].instanceToken;
    registry.close(token, actor);
    expect(publish(registry)).toEqual(first);
    expect(() => registry.get(token, actor)).toThrow();
  });
  it("does not publish errors or non-App output", () => {
    const registry = new ModelAppRegistry();
    const result = { isError: true, content: [] };
    expect(registry.publish(result, owner, "tool", "rev", meta)).toBe(result);
    const ordinary = { content: [] };
    expect(registry.publish(ordinary, owner, "tool", "rev", {})).toBe(ordinary);
  });
});

it("keeps structured context as background, removes blocks, and acknowledges retry without resurrecting them", () => {
  const registry = new ModelAppRegistry();
  const token = publish(registry)._meta[PLUGIN_MODEL_APP_META].instanceToken;
  const { context, owner: source } = registry.get(token, actor);
  const id = source.owner.instanceId;
  const structured = context.update(id, 1, {
    operationId: "structured",
    sequence: 1,
    params: { content: [], structuredContent: { fixture: true } },
  });
  // Not a content block, so nothing to remove.
  expect(() =>
    context.remove(id, 1, {
      operationId: "remove-structured",
      updateId: structured._meta["openai/modelContext"].updateId,
      index: 0,
    }),
  ).toThrow("INSTANCE_CONTEXT_REMOVAL_STALE");
  const update = context.update(id, 1, {
    operationId: "text",
    sequence: 2,
    params: {
      content: [{ type: "text", text: "Drop text" }],
      structuredContent: { fixture: true },
    },
  });
  const request = {
    operationId: "remove-text",
    updateId: update._meta["openai/modelContext"].updateId,
    index: 0,
  };
  const removed = context.remove(id, 1, request);
  expect(removed.state?.content).toEqual([]);
  expect(removed.state?.structuredContent).toEqual({ fixture: true });
  expect(context.remove(id, 1, request)).toEqual(removed);
  // The removal holds: the App's own update is refused; the person using the
  // App attaches again.
  const resend = {
    operationId: "mixed",
    sequence: 3,
    params: {
      content: [{ type: "text", text: "Keep text" }],
      structuredContent: { fixture: true },
    },
  };
  expect(() => context.update(id, 1, resend)).toThrow("INSTANCE_CONTEXT_HELD");
  expect(context.snapshot(id, 1).state?.content).toEqual([]);
  const mixed = context.update(id, 1, { ...resend, attach: "user" });
  expect(mixed._meta["openai/modelContext"].updateId).toBeTypeOf("string");
  expect(context.snapshot(id, 1).state).toMatchObject(resend.params);
  registry.close(token, actor);
});
