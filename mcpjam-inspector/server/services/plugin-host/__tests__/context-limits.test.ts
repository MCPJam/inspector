import { describe, expect, it } from "vitest";
import { MODEL_CONTEXT_POLICY_CEILINGS } from "@mcpjam/sdk/host-config/internal";
import { PluginContextWorkspace } from "../context.js";

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
const blocks = (count: number) =>
  Array.from({ length: count }, (_, index) => ({
    type: "text",
    text: `part ${index}`,
  }));
/** Stored context a larger policy admitted: 256 blocks, past the default 64. */
const stored = JSON.stringify({
  version: 1,
  revision: 1,
  cursor: {
    operationId: "op-1",
    fingerprint: "a".repeat(64),
    sequence: 1,
    updateId: "6f1e1c2a-2b8d-4a63-9d2c-3c7a1f0e9b11",
  },
  context: {
    updateId: "6f1e1c2a-2b8d-4a63-9d2c-3c7a1f0e9b11",
    params: { content: blocks(256) },
  },
  removals: [],
});

describe("context already admitted is re-read against the ceilings", () => {
  it("restores and forks stored context larger than the default budgets", () => {
    const ws = workspace();
    ws.restore(instanceId, 1, stored, 1);
    expect(ws.snapshot(instanceId, 1).state?.content).toHaveLength(256);
    const copy = ws.fork(instanceId, 1);
    expect(copy.snapshot(instanceId, 1).state?.content).toHaveLength(256);
  });

  it("still admits a new update against the default budgets", () => {
    const ws = workspace();
    ws.restore(instanceId, 1, stored, 1);
    expect(() =>
      ws.update(instanceId, 1, {
        operationId: "op-2",
        sequence: 2,
        params: { content: blocks(65) },
      }),
    ).toThrow("PLUGIN_CONTEXT_TOO_LARGE");
    // The stored context is untouched by the refusal.
    expect(ws.snapshot(instanceId, 1)).toMatchObject({ revision: 1 });
    ws.update(instanceId, 1, {
      operationId: "op-2",
      sequence: 2,
      params: { content: blocks(64) },
    });
    expect(ws.snapshot(instanceId, 1).state?.content).toHaveLength(64);
  });

  it("admits a new update against the limits it is given", () => {
    const ws = workspace();
    ws.update(
      instanceId,
      1,
      { operationId: "op-1", sequence: 1, params: { content: blocks(256) } },
      MODEL_CONTEXT_POLICY_CEILINGS,
    );
    expect(ws.snapshot(instanceId, 1).state?.content).toHaveLength(256);
  });
});
