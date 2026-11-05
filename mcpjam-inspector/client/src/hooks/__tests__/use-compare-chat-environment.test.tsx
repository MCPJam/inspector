import { renderHook } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { useCompareChatEnvironment } from "../use-compare-chat-environment";

const state = vi.hoisted(() => ({ enabled: false, inputs: vi.fn() }));
vi.mock("../useProjectEnvironmentsEnabled", () => ({
  useProjectEnvironmentsEnabled: () => state.enabled,
}));
vi.mock("../use-playground-hidden-environment", () => ({
  usePlaygroundHiddenEnvironment: (input: {
    hostId: string;
    eligible: boolean;
  }) => {
    state.inputs(input);
    return {
      wanted: input.eligible,
      environmentId: `env_${input.hostId}`,
      pluginServerIds: [],
      venue: "hosted",
    };
  },
}));

describe("compare composition", () => {
  beforeEach(() => {
    state.enabled = false;
    state.inputs.mockClear();
  });
  it("keeps three clients' compositions separate", () => {
    const { result } = renderHook(() =>
      ["a", "b", "c"].map((hostId) =>
        useCompareChatEnvironment({
          hostedContext: { projectId: "p", hostId },
          hostResolved: true,
        }),
      ),
    );
    expect(
      result.current.map(
        (column) => column.columnHostedContext.hiddenEnvironment?.environmentId,
      ),
    ).toEqual(["env_a", "env_b", "env_c"]);
  });
  it("attaches plugins when the environments UI is enabled but no environment is selected", () => {
    state.enabled = true;
    const { result } = renderHook(() =>
      useCompareChatEnvironment({
        hostedContext: { projectId: "p", hostId: "a" },
        hostResolved: true,
      }),
    );
    expect(state.inputs).toHaveBeenLastCalledWith(
      expect.objectContaining({ eligible: true }),
    );
    expect(
      result.current.columnHostedContext.hiddenEnvironment,
    ).toBeDefined();
  });
});
