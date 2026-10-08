import { describe, expect, it } from "vitest";
import { PluginContextWorkspace } from "../context.js";

const instanceId = "33333333-3333-4333-8333-333333333333";
const identity = {
  workspaceId: "w",
  scope: { kind: "global" as const },
  pluginVersionId: "v",
  serverId: "s",
  bindingId: "b",
  origin: { kind: "global" as const, id: "app" },
};
const view = (text: string) => ({ content: [{ type: "text", text }] });
const workspace = () => {
  const ws = new PluginContextWorkspace("w");
  ws.attach(instanceId, 1, identity);
  return ws;
};

describe("a removed App context stays removed", () => {
  it("refuses the App's own update after a removal until the person attaches again", () => {
    const ws = workspace();
    const first = { operationId: "u-1", sequence: 1, params: view("camera A") };
    ws.update(instanceId, 1, first);
    const updateId = ws.snapshot(instanceId, 1).state!.updateId;
    ws.remove(instanceId, 1, { operationId: "rm-1", updateId, index: 0 });
    // A retried pre-removal update acknowledges without resurrecting it.
    ws.update(instanceId, 1, first);
    expect(ws.snapshot(instanceId, 1).state).toBeNull();
    // The App re-posts its (slightly different) view on its own.
    const resend = {
      operationId: "u-2",
      sequence: 2,
      params: view("camera B"),
    };
    expect(() => ws.update(instanceId, 1, resend)).toThrow(
      "INSTANCE_CONTEXT_HELD",
    );
    expect(ws.snapshot(instanceId, 1)).toMatchObject({
      sequence: 1,
      state: null,
    });
    // The hold is part of the saved state, so another process holds it too.
    const saved = ws.export(instanceId, 1);
    expect(JSON.parse(saved).held).toBe(true);
    const cold = workspace();
    cold.restore(instanceId, 1, saved);
    expect(() => cold.update(instanceId, 1, resend)).toThrow(
      "INSTANCE_CONTEXT_HELD",
    );
    cold.update(instanceId, 1, { ...resend, attach: "user" });
    expect(cold.snapshot(instanceId, 1).state?.content).toEqual(
      view("camera B").content,
    );
    expect(JSON.parse(cold.export(instanceId, 1)).held).toBeUndefined();
    // Attached again, the App's own updates are accepted.
    cold.update(instanceId, 1, {
      operationId: "u-3",
      sequence: 3,
      params: view("camera C"),
    });
  });

  it("restores saved state written before the hold existed", () => {
    const ws = workspace();
    ws.update(instanceId, 1, {
      operationId: "u-1",
      sequence: 1,
      params: view("kept"),
    });
    const legacy = JSON.parse(ws.export(instanceId, 1));
    expect(legacy).not.toHaveProperty("held");
    const cold = workspace();
    cold.restore(instanceId, 1, JSON.stringify(legacy));
    cold.update(instanceId, 1, {
      operationId: "u-2",
      sequence: 2,
      params: view("next"),
    });
  });

  it("removes every visible block in one request, keeping background context", () => {
    const ws = workspace();
    ws.update(instanceId, 1, {
      operationId: "u-1",
      sequence: 1,
      params: {
        content: [
          { type: "text", text: "Current view" },
          {
            type: "text",
            text: "hidden",
            annotations: { audience: ["assistant"] },
          },
          { type: "resource_link", uri: "cad://part", name: "part" },
        ],
        structuredContent: { page: "part" },
      },
    });
    const updateId = ws.snapshot(instanceId, 1).state!.updateId;
    const all = { operationId: "rm-all", updateId, index: "all" as const };
    const removed = ws.remove(instanceId, 1, all);
    expect(removed.state).toMatchObject({
      content: [
        {
          type: "text",
          text: "hidden",
          annotations: { audience: ["assistant"] },
        },
      ],
      structuredContent: { page: "part" },
    });
    expect(removed.revision).toBe(2);
    // A retry acknowledges without removing again.
    expect(ws.remove(instanceId, 1, all)).toEqual(removed);
    // Nothing visible is left to remove.
    expect(() =>
      ws.remove(instanceId, 1, {
        operationId: "rm-again",
        updateId: removed.state!.updateId,
        index: "all",
      }),
    ).toThrow("INSTANCE_CONTEXT_REMOVAL_STALE");
    // It holds like any removal.
    expect(() =>
      ws.update(instanceId, 1, {
        operationId: "u-2",
        sequence: 2,
        params: view("camera B"),
      }),
    ).toThrow("INSTANCE_CONTEXT_HELD");
  });
});
