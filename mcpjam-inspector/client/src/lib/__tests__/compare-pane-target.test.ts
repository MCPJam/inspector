import { describe, expect, it, vi } from "vitest";
import { normalizeExecutionTarget } from "@/shared/execution-target";
import { buildComparePaneTarget } from "../compare-pane-target";

describe("compare turn targets", () => {
  const target = { kind: "environment", environmentId: "named" } as const;
  const ensureServerIds = vi.fn();
  const composition = {
    wanted: true,
    environmentId: "adhoc",
    pluginServerIds: ["from-plugin"],
  };
  const client = { hostId: "presented", composition, ensureServerIds };

  it.each([
    undefined,
    { serverIds: [] },
    { pluginVersionIds: [] },
    { serverIds: ["a"], pluginVersionIds: ["v"] },
  ])(
    "sends one authoritative named target with just its explicit narrowing: %j",
    (overrides) => {
      const ctx = buildComparePaneTarget({ ...client, target, overrides });
      expect(normalizeExecutionTarget(ctx)).toEqual({
        ok: true,
        target: { ...target, ...(overrides ? { overrides } : {}) },
      });
      expect(ctx).toMatchObject({
        presentationHostId: "presented",
        requiresWebChatApi: true,
      });
      expect(ctx).not.toHaveProperty("ensureServerIds");
      expect(ctx).not.toHaveProperty("hiddenEnvironment");
    },
  );

  it("keeps the client preflight and hidden plugin composition off the named sibling", () => {
    const ctx = buildComparePaneTarget({
      ...client,
      target: { kind: "host", hostId: "sibling" },
    });
    expect(ctx).toMatchObject({
      hostId: "sibling",
      ensureServerIds,
      hiddenEnvironment: { environmentId: "adhoc" },
    });
    expect(ctx).not.toHaveProperty("executionTarget");
    expect(ctx).not.toHaveProperty("environmentOverrides");
  });

  it("leaves a guest without a saved client or plugins an ordinary ad hoc chat", () => {
    expect(
      buildComparePaneTarget({
        composition: { ...composition, wanted: false },
      }),
    ).toEqual({});
  });
});
