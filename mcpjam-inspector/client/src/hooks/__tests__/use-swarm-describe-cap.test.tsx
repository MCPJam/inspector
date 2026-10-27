import { act, renderHook } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { SWARM_INTENSITY_PRESETS } from "@/components/swarms/swarm-intensity";

const capForMock = vi.fn();
let cap: {
  max: number | null;
  credits: number | null;
  conversationCredits: number | null;
};
vi.mock("@/hooks/use-swarm-credit-cap", () => ({
  useSwarmCreditCap: () => ({ ...cap, capFor: capForMock }),
}));

import { useSwarmDescribeCap } from "../use-swarm-describe-cap";

const REUSED: string[] = [];
const render = (environmentIds: string[] = ["env-1"], composeMode = false) =>
  renderHook(() =>
    useSwarmDescribeCap({
      projectId: "project-1",
      organizationId: "org-1",
      environmentIds,
      composeMode,
      selectionKey: environmentIds.join(","),
      preset: SWARM_INTENSITY_PRESETS.quick,
      judgeConfig: undefined,
      reusedPersonaIds: REUSED,
    }),
  );

beforeEach(() => {
  capForMock.mockReset();
  cap = { max: null, credits: null, conversationCredits: null };
});

describe("useSwarmDescribeCap", () => {
  it("keeps the preset and shows nothing without a cap", () => {
    const { result } = render();
    expect(result.current.canGenerate).toBe(true);
    expect(result.current.size).toEqual({ personaCount: 3, journeyCount: 5 });
    expect(result.current.notice).toBeNull();
  });

  it("turns Generate off when a few conversations fit but not one goal", () => {
    // 2 conversations across 3 environments: a goal needs 3.
    cap = { max: 2, credits: 50, conversationCredits: 20 };
    const { result } = render(["env-1", "env-2", "env-3"]);
    expect(result.current.canGenerate).toBe(false);
    expect(result.current.notice).toMatchObject({ max: 0, credits: 50 });
  });

  it("uses the click-time cap only until its inputs change", async () => {
    cap = { max: null, credits: 12, conversationCredits: null };
    capForMock.mockResolvedValue({
      max: 0,
      reusedConversations: 0,
      conversationCredits: 20,
    });
    const { result, rerender } = render([], true);

    let size: unknown;
    await act(async () => {
      size = await result.current.sizeAtClick(["adhoc-1"]);
    });
    expect(size).toBeNull();
    expect(result.current.canGenerate).toBe(false);

    // Credits were added: Describe goes back to the live cap, which in compose
    // mode is unknown until the next click.
    cap = { max: null, credits: 400, conversationCredits: null };
    rerender();
    expect(result.current.canGenerate).toBe(true);
    expect(result.current.notice).toBeNull();
  });

  it("sizes the generation from the click-time cap", async () => {
    capForMock.mockResolvedValue({
      max: 7,
      reusedConversations: 0,
      conversationCredits: 20,
    });
    const { result } = render([], true);
    let size: unknown;
    await act(async () => {
      size = await result.current.sizeAtClick(["adhoc-1"]);
    });
    expect(size).toEqual({ personaCount: 3, journeyCount: 2 });
    expect(capForMock).toHaveBeenCalledWith({
      environmentIds: ["adhoc-1"],
      reusedPersonaIds: [],
    });
    expect(result.current.size).toEqual({ personaCount: 3, journeyCount: 2 });
  });
});
