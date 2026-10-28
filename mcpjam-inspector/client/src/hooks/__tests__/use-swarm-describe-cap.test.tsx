import { act, renderHook } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { SWARM_INTENSITY_PRESETS } from "@/components/swarms/swarm-intensity";

const capForMock = vi.fn();
const creditCapArgs = vi.fn();
let cap: {
  max: number | null;
  credits: number | null;
  goalCredits: number | null;
  stateKey?: string;
};
let journeysByPersona: Record<string, unknown>;
vi.mock("convex/react", () => ({
  useConvex: () => ({ query: vi.fn() }),
  useQueries: () => journeysByPersona,
}));
vi.mock("@/hooks/use-swarm-credit-cap", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/hooks/use-swarm-credit-cap")>()),
  useSwarmCreditCap: (args: unknown) => {
    creditCapArgs(args);
    return {
      stateKey: JSON.stringify(cap.credits),
      ...cap,
      capFor: capForMock,
    };
  },
}));

import { useSwarmDescribeCap } from "../use-swarm-describe-cap";

const NO_REUSED: string[] = [];
const render = (
  environmentIds: string[] = ["env-1"],
  composeMode = false,
  reusedPersonaIds: string[] = NO_REUSED,
) =>
  renderHook(() =>
    useSwarmDescribeCap({
      projectId: "project-1",
      organizationId: "org-1",
      environmentIds,
      composeMode,
      selectionKey: environmentIds.join(","),
      preset: SWARM_INTENSITY_PRESETS.quick,
      judgeConfig: undefined,
      reusedPersonaIds,
    }),
  );

beforeEach(() => {
  capForMock.mockReset();
  creditCapArgs.mockReset();
  journeysByPersona = {};
  cap = { max: null, credits: null, goalCredits: null };
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
    cap = { max: 2, credits: 50, goalCredits: 20 };
    const { result } = render(["env-1", "env-2", "env-3"]);
    expect(result.current.canGenerate).toBe(false);
    expect(result.current.notice).toMatchObject({ max: 0, credits: 50 });
  });

  it("uses the click-time cap only until its inputs change", async () => {
    cap = { max: null, credits: 12, goalCredits: null };
    capForMock.mockResolvedValue({
      max: 0,
      reusedConversations: 0,
      goalCredits: 20,
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
    cap = { max: null, credits: 400, goalCredits: null };
    rerender();
    expect(result.current.canGenerate).toBe(true);
    expect(result.current.notice).toBeNull();
  });

  it("sizes the generation from the click-time cap", async () => {
    capForMock.mockResolvedValue({
      max: 7,
      reusedConversations: 0,
      goalCredits: 20,
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

  it("counts reused personas' goals in the live cap, at the seed Confirm uses", () => {
    const reused = ["persona-1"];
    journeysByPersona = {
      "persona-1": [
        { _id: "goal-1", config: { sessionsPerTarget: 2 } },
        { _id: "goal-2", config: { sessionsPerTarget: 2 } },
      ],
    };
    cap = { max: 7, credits: 140, goalCredits: 20 };
    const { result } = render(["env-1"], false, reused);

    expect(creditCapArgs).toHaveBeenLastCalledWith(
      expect.objectContaining({
        reusedGoals: [
          { journeyId: "goal-1", sessions: 2 },
          { journeyId: "goal-2", sessions: 2 },
        ],
      }),
    );
    // 4 of the 7 conversations are the reused goals': 3 new goals fit.
    expect(result.current.size).toEqual({ personaCount: 3, journeyCount: 1 });
  });

  it("gives no live cap until the reused personas' goals have loaded", () => {
    cap = { max: 7, credits: 140, goalCredits: 20 };
    const { result } = render(["env-1"], false, ["persona-1"]);
    expect(result.current.notice).toBeNull();
    expect(result.current.size).toEqual({ personaCount: 3, journeyCount: 5 });
  });

  it("drops the click-time cap when the free allowance or balance changes, for good", async () => {
    cap = { max: null, credits: 12, goalCredits: null, stateKey: "a" };
    capForMock.mockResolvedValue({
      max: 0,
      reusedConversations: 0,
      goalCredits: 20,
    });
    const { result, rerender } = render([], true);
    await act(async () => {
      await result.current.sizeAtClick(["adhoc-1"]);
    });
    expect(result.current.canGenerate).toBe(false);

    cap = { ...cap, stateKey: "b" };
    rerender();
    expect(result.current.canGenerate).toBe(true);
    // Going back to the old inputs does not bring the old reading back.
    cap = { ...cap, stateKey: "a" };
    rerender();
    expect(result.current.canGenerate).toBe(true);
  });
});
