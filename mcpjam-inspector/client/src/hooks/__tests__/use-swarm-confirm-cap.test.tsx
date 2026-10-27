import { renderHook } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

let cap: {
  max: number | null;
  credits: number | null;
  conversationCredits: number | null;
  maxFor?: (goals: { journeyId: string; sessions: number }[]) => number | null;
};
vi.mock("@/hooks/use-swarm-credit-cap", () => ({
  useSwarmCreditCap: () => cap,
}));

import { useSwarmConfirmCap } from "../use-swarm-confirm-cap";

const goals = (...texts: string[]) => texts.map((goal) => ({ goal }));

const render = (
  overrides: Partial<Parameters<typeof useSwarmConfirmCap>[0]> = {},
) =>
  renderHook(() =>
    useSwarmConfirmCap({
      projectId: "project-1",
      organizationId: "org-1",
      environmentIds: ["env-1"],
      reusedGoals: [],
      maxTurns: 6,
      judgeConfig: undefined,
      launchCount: 6,
      environmentCount: 1,
      proposed: [
        { journeys: goals("a", "b"), iterations: 1 },
        { journeys: goals("c", "d", "e", "f"), iterations: 1 },
      ],
      reusedIterations: [],
      locked: false,
      ...overrides,
    }),
  ).result.current;

beforeEach(() => {
  cap = { max: 7, credits: 140, conversationCredits: 20 };
});

describe("useSwarmConfirmCap", () => {
  it("allows a step that lands on the max and refuses one that passes it", () => {
    const confirm = render();
    // 6 of 7: one more goal fits, another iteration of a 2-goal persona does not.
    expect(confirm.fits(1)).toBe(true);
    expect(confirm.fits(2)).toBe(false);
    expect(confirm.iterationsCap(2, 1)).toBe(1);
    expect(confirm.capReason).toBe(
      "Your credits cover up to 7 conversations. Remove a goal or lower iterations to add more.",
    );
  });

  it("counts an empty draft goal toward the next step", () => {
    const confirm = render({
      proposed: [
        { journeys: goals("a", "b", ""), iterations: 1 },
        { journeys: goals("c", "d", "e", "f"), iterations: 1 },
      ],
    });
    expect(confirm.fits(1)).toBe(false);
  });

  it("shows the notice only at the max, and blocks Continue above it", () => {
    cap = { max: 20, credits: 400, conversationCredits: 20 };
    expect(render().notice).toBeNull();

    cap = { max: 7, credits: 140, conversationCredits: 20 };
    const over = render({ launchCount: 9 });
    expect(over.blockedReason).toBe(
      "Your credits cover up to 7 conversations, and this swarm has 9.",
    );
    expect(over.notice).toMatchObject({ max: 7, count: 9, locked: false });
  });

  it("tells a locked swarm whether lowering iterations is still possible", () => {
    const atOne = render({ launchCount: 9, locked: true });
    expect(atOne.notice).toMatchObject({
      locked: true,
      iterationsAtMinimum: true,
    });
    const atTwo = render({
      launchCount: 9,
      locked: true,
      reusedIterations: [2],
    });
    expect(atTwo.notice?.iterationsAtMinimum).toBe(false);
  });

  it("turns every rule off without a cap", () => {
    cap = { max: null, credits: 140, conversationCredits: null };
    const confirm = render({ launchCount: 900 });
    expect(confirm.fits(50)).toBe(true);
    expect(confirm.iterationsCap(2, 1)).toBe(Number.POSITIVE_INFINITY);
    expect(confirm.blockedReason).toBeNull();
    expect(confirm.notice).toBeNull();
    expect(confirm.capReason).toBeNull();
  });

  it("re-prices a reused persona's goals at each extra iteration", () => {
    // 100 credits; the reused goal costs 25 a run, new goals 10. At one
    // iteration the max is 1 + 75 / 10 = 8, but each further iteration of the
    // reused goal shrinks it: at 4 the goal alone takes the 100.
    cap = {
      max: 8,
      credits: 100,
      conversationCredits: 10,
      maxFor: (goals) => {
        const reusedRuns = goals[0]?.sessions ?? 0;
        const left = 100 - 25 * reusedRuns;
        return left < 0
          ? Math.floor(100 / 25)
          : reusedRuns + Math.floor(left / 10);
      },
    };
    const confirm = render({
      launchCount: 1,
      proposed: [],
      reusedGoals: [{ journeyId: "goal-1", sessions: 1 }],
      reusedIterations: [1],
    });
    expect(confirm.reusedIterationsCap(["goal-1"], 1)).toBe(4);
    // One shared price would have allowed every iteration up to 5.
    expect(confirm.iterationsCap(1, 1)).toBe(8);
  });
});
