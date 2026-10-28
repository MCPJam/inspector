import { describe, it, expect, vi } from "vitest";
import { ModelAppRegistry } from "../model-apps.js";
import { PluginContextMemory } from "../context-memory.js";
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
  it("counts an open model App's context against this process's memory", () => {
    const registry = new ModelAppRegistry(
      60_000,
      new PluginContextMemory(64 * 1024, 1024 * 1024),
    );
    const open = (toolName: string) =>
      (
        registry.publish(
          { content: [] },
          owner,
          toolName,
          "tool-rev",
          meta,
        ) as any
      )._meta[PLUGIN_MODEL_APP_META].instanceToken as string;
    const update = (token: string, sequence: number, text: string) =>
      registry.updateContext(token, actor, {
        operationId: `op-${sequence}`,
        sequence,
        params: { content: [{ type: "text", text }] },
        // After its context is removed, the person uses the App again.
        ...(sequence > 1 ? { attach: "user" as const } : {}),
      });
    const first = open("first");
    const second = open("second");
    update(first, 1, "x".repeat(40_000));
    expect(() => update(second, 1, "y".repeat(30_000))).toThrow(
      "PLUGIN_CONTEXT_MEMORY_LIMIT",
    );
    // Removing the first App's context frees its bytes, and so does closing.
    registry.removeContext(first, actor, { operationId: "remove", basis: 0 });
    update(second, 1, "y".repeat(30_000));
    expect(() => update(first, 2, "x".repeat(40_000))).toThrow(
      "PLUGIN_CONTEXT_MEMORY_LIMIT",
    );
    registry.close(second, actor);
    update(first, 2, "x".repeat(40_000));
  });
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

it("removes all of a model App's context, including what the chip doesn't show, and acknowledges a retry", () => {
  const registry = new ModelAppRegistry();
  const token = publish(registry)._meta[PLUGIN_MODEL_APP_META].instanceToken;
  const { context, owner: source } = registry.get(token, actor);
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
  registry.close(token, actor);
});
