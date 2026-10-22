import { describe, expect, it } from "vitest";
import { PluginContextWorkspace } from "../context.js";
import { decideContextRemoveAll } from "../context-removal.js";

const instanceId = "44444444-4444-4444-8444-444444444444";
const identity = {
  workspaceId: "w",
  scope: { kind: "global" as const },
  pluginVersionId: "v",
  serverId: "s",
  bindingId: "b",
  origin: { kind: "global" as const, id: "app" },
};
const workspace = () => {
  const ws = new PluginContextWorkspace("w");
  ws.attach(instanceId, 1, identity);
  return ws;
};
let sequence = 0;
const update = (
  ws: PluginContextWorkspace,
  params: Record<string, unknown>,
  attach?: "user",
) =>
  ws.update(instanceId, 1, {
    operationId: `u-${++sequence}`,
    sequence: ws.snapshot(instanceId, 1).sequence + 1,
    params,
    ...(attach ? { attach } : {}),
  });
const text = (value: string) => ({ content: [{ type: "text", text: value }] });

describe("remove-all decision table", () => {
  const removal = { cursor: 3, removedAt: 2, attachedAt: 3 };
  const decide = (
    basis: number,
    input: Partial<Parameters<typeof decideContextRemoveAll>[0]> = {},
  ) =>
    decideContextRemoveAll({
      request: { operationId: "op", basis },
      receipt: undefined,
      held: false,
      removal,
      ...input,
    });
  it("answers each row and only `apply` lets the caller write", () => {
    expect(decide(0, { receipt: JSON.stringify(["all", 0]) })).toBe("applied");
    expect(() => decide(1, { receipt: JSON.stringify(["all", 0]) })).toThrow(
      "INSTANCE_CONTEXT_DUPLICATE_MISMATCH",
    );
    expect(decide(1, { held: true })).toBe("in-effect");
    expect(decide(1, { held: false })).toBe("superseded");
    expect(decide(2)).toBe("stale");
    expect(decide(3)).toBe("apply");
  });
  it("refuses a basis the server never issued", () => {
    for (const basis of [-1, 4, 1.5, Number.MAX_SAFE_INTEGER + 1])
      expect(() => decide(basis)).toThrow("INSTANCE_CONTEXT_REMOVAL_INVALID");
    expect(() =>
      decideContextRemoveAll({
        request: { operationId: "", basis: 0 },
        receipt: undefined,
        held: false,
        removal,
      }),
    ).toThrow("INSTANCE_CONTEXT_REMOVAL_INVALID");
  });
});

describe("removing all of an App's context", () => {
  it("clears visible, assistant-only and structured context in one revision", () => {
    const ws = workspace();
    update(ws, {
      content: [
        { type: "text", text: "Visible" },
        {
          type: "text",
          text: "Background",
          annotations: { audience: ["assistant"] },
        },
      ],
      structuredContent: { page: "/parts" },
    });
    const before = ws.snapshot(instanceId, 1);
    const removed = ws.removeAll(instanceId, 1, {
      operationId: "rm",
      basis: 0,
    });
    expect(removed).toEqual({
      outcome: "applied",
      snapshot: {
        revision: before.revision + 1,
        sequence: before.sequence,
        state: null,
        held: true,
        cursor: 1,
        removedAt: 1,
        attachedAt: 0,
      },
    });
    // Nothing of it reaches a turn, hidden blocks included.
    for (const context of ws.contexts("t")) {
      expect(context.content).toEqual([]);
      expect(context).not.toHaveProperty("structuredContent");
    }
  });

  it("never reads an ordinary empty update as a removal", () => {
    const ws = workspace();
    update(ws, text("first"));
    update(ws, { content: [] });
    const snapshot = ws.snapshot(instanceId, 1);
    expect(snapshot.state).toBeNull();
    expect(snapshot).not.toHaveProperty("held");
    expect(snapshot).not.toHaveProperty("removedAt");
    // So the App may update again: nothing holds it.
    update(ws, text("next"));
    expect(ws.snapshot(instanceId, 1).state?.content).toEqual(
      text("next").content,
    );
  });

  it("keeps context the person attached after a removal that landed", () => {
    const ws = workspace();
    update(ws, text("old"));
    const request = { operationId: "rm", basis: 0 };
    ws.removeAll(instanceId, 1, request);
    // The acknowledgement is lost; meanwhile the person attaches again.
    update(ws, text("new"), "user");
    // The retry answers from its receipt and erases nothing.
    expect(ws.removeAll(instanceId, 1, request).outcome).toBe("applied");
    // A different operation from the same view is superseded.
    expect(
      ws.removeAll(instanceId, 1, { operationId: "rm-2", basis: 0 }).outcome,
    ).toBe("superseded");
    expect(ws.snapshot(instanceId, 1).state?.content).toEqual(
      text("new").content,
    );
  });

  it("is stale, and erases nothing, when the person attached before a removal landed", () => {
    const ws = workspace();
    update(ws, text("old"));
    const basis = ws.snapshot(instanceId, 1).cursor ?? 0;
    // The removal never reached the server; the person attaches first.
    update(ws, text("new"), "user");
    const revision = ws.snapshot(instanceId, 1).revision;
    const result = ws.removeAll(instanceId, 1, { operationId: "rm", basis });
    expect(result.outcome).toBe("stale");
    expect(result.snapshot).toMatchObject({
      revision,
      state: { content: text("new").content },
      cursor: 1,
      attachedAt: 1,
    });
    expect(result.snapshot).not.toHaveProperty("held");
  });

  it("restores the cursor from saved state, and context saved before it existed", () => {
    const ws = workspace();
    update(ws, text("old"));
    ws.removeAll(instanceId, 1, { operationId: "rm", basis: 0 });
    const saved = JSON.parse(ws.export(instanceId, 1));
    expect(saved.removal).toEqual({ cursor: 1, removedAt: 1, attachedAt: 0 });
    const cold = workspace();
    cold.restore(instanceId, 1, JSON.stringify(saved));
    expect(cold.snapshot(instanceId, 1)).toEqual(ws.snapshot(instanceId, 1));
    expect(
      cold.removeAll(instanceId, 1, { operationId: "late", basis: 0 }).outcome,
    ).toBe("in-effect");
    // An export written before remove-all has no cursor: no removals yet.
    const legacy = workspace();
    update(legacy, text("kept"));
    const old = JSON.parse(legacy.export(instanceId, 1));
    expect(old).not.toHaveProperty("removal");
    const restored = workspace();
    restored.restore(instanceId, 1, JSON.stringify({ ...old, held: true }));
    expect(restored.snapshot(instanceId, 1)).toMatchObject({ held: true });
    expect(restored.snapshot(instanceId, 1)).not.toHaveProperty("cursor");
    expect(
      restored.removeAll(instanceId, 1, { operationId: "rm", basis: 0 })
        .outcome,
    ).toBe("applied");
    // A cursor that contradicts itself is refused.
    expect(() =>
      workspace().restore(
        instanceId,
        1,
        JSON.stringify({
          ...saved,
          removal: { cursor: 1, removedAt: 2, attachedAt: 0 },
        }),
      ),
    ).toThrow();
  });
});
