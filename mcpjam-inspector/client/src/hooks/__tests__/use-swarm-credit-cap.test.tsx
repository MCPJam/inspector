import { renderHook } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { CreditBalanceState } from "@/hooks/useCreditBalance";
import type { SwarmSponsorshipAllowanceState } from "@/hooks/use-swarm-sponsorship-allowance";

const softQueryMock = vi.fn();
const convexQueryMock = vi.fn();
let balance: CreditBalanceState | undefined;
let estimateResult: { data?: unknown; error?: Error };
let allowance: SwarmSponsorshipAllowanceState;

vi.mock("convex/react", () => ({
  useConvex: () => ({ query: convexQueryMock }),
}));
vi.mock("@/hooks/use-soft-query", () => ({
  useSoftQuery: (...args: unknown[]) => softQueryMock(...args),
}));
vi.mock("@/hooks/useCreditBalance", () => ({
  useCreditBalance: () => ({ balance }),
}));
vi.mock("@/hooks/use-swarm-sponsorship-allowance", () => ({
  useSwarmSponsorshipAllowanceState: () => allowance,
}));

import { useSwarmCreditCap } from "../use-swarm-credit-cap";

const ESTIMATE = {
  environments: [
    {
      environmentId: "env-1",
      tokenCredits: 20,
      feeCredits: 0,
      freeEligible: true,
    },
  ],
  reused: [],
};

const render = (environmentIds: string[] = ["env-1"]) =>
  renderHook(() =>
    useSwarmCreditCap({
      projectId: "project-1",
      organizationId: "org-1",
      environmentIds,
      maxTurns: 6,
    }),
  );

beforeEach(() => {
  softQueryMock.mockReset();
  estimateResult = { data: ESTIMATE };
  // Like the real hook: a skipped read has no data.
  softQueryMock.mockImplementation((_name: string, args: unknown) =>
    args === "skip" ? { data: undefined, error: undefined } : estimateResult,
  );
  convexQueryMock.mockReset();
  balance = {
    paidCreditsRemaining: 40,
    hasPurchaseHistory: true,
    freeDailyPercentUsed: 0,
    freeDailyResetAt: 0,
    freeDailyCreditsRemaining: 100,
    freeDailyCreditsTotal: 300,
    walletLocked: false,
    billingModel: "daily",
  };
  allowance = { status: "ready", remaining: 4, granted: 500 };
});

describe("useSwarmCreditCap", () => {
  it("adds the free conversations left to what the credits pay for", () => {
    const { result } = render();
    expect(result.current.max).toBe(11);
    expect(result.current.credits).toBe(140);
    expect(softQueryMock).toHaveBeenCalledWith(
      "swarms/conversationEstimate:estimateSwarmConversationCredits",
      { projectId: "project-1", environmentIds: ["env-1"], maxTurns: 6 },
    );
  });

  it("counts no free conversations where sponsorship is not offered", () => {
    allowance = { status: "unsupported" };
    expect(render().result.current.max).toBe(7);
  });

  it.each([["loading"], ["error"]] as const)(
    "gives no cap while the allowance is %s",
    (status) => {
      allowance = { status };
      expect(render().result.current.max).toBeNull();
    },
  );

  it("gives no cap when the estimate failed or the balance is unknown", () => {
    estimateResult = { data: undefined, error: new Error("x") };
    expect(render().result.current.max).toBeNull();
    estimateResult = { data: ESTIMATE };
    balance = undefined;
    expect(render().result.current.max).toBeNull();
  });

  it("asks nothing until there is an environment", () => {
    const { result } = render([]);
    expect(softQueryMock).toHaveBeenCalledWith(
      "swarms/conversationEstimate:estimateSwarmConversationCredits",
      "skip",
    );
    expect(result.current.max).toBeNull();
  });

  it("prices targets known only at click time, and fails open", async () => {
    const { result } = render([]);
    convexQueryMock.mockResolvedValueOnce(ESTIMATE);
    await expect(
      result.current.capFor({ environmentIds: ["env-1"] }),
    ).resolves.toEqual({
      max: 11,
      reusedConversations: 0,
      goalCredits: 20,
    });

    convexQueryMock.mockRejectedValueOnce(new Error("no such function"));
    await expect(
      result.current.capFor({ environmentIds: ["env-1"] }),
    ).resolves.toEqual({
      max: null,
      reusedConversations: 0,
      goalCredits: null,
    });
  });

  it("loads a reused persona's goals at click time and counts them first", async () => {
    allowance = { status: "unsupported" };
    const { result } = render([]);
    convexQueryMock.mockImplementation(
      async (_query: unknown, args: Record<string, unknown>) =>
        "personaRefId" in args
          ? [{ _id: "goal-1", config: { sessionsPerTarget: 2 } }]
          : {
              ...ESTIMATE,
              reused: [
                {
                  journeyId: "goal-1",
                  sessionsPerTarget: 2,
                  environments: ESTIMATE.environments,
                },
              ],
            },
    );

    const cap = await result.current.capFor({
      environmentIds: ["env-1"],
      reusedPersonaIds: ["persona-1"],
    });

    expect(convexQueryMock).toHaveBeenLastCalledWith(expect.anything(), {
      projectId: "project-1",
      environmentIds: ["env-1"],
      maxTurns: 6,
      reusedJourneyIds: ["goal-1"],
    });
    // 2 reused conversations at 20 leave 100: five new ones.
    expect(cap).toEqual({
      max: 7,
      reusedConversations: 2,
      goalCredits: 20,
    });
  });

  it("prices reused goals at the iterations they will launch with", () => {
    estimateResult = {
      data: {
        ...ESTIMATE,
        reused: [
          {
            journeyId: "goal-1",
            sessionsPerTarget: 1,
            environments: ESTIMATE.environments,
          },
        ],
      },
    };
    allowance = { status: "unsupported" };
    const { result } = renderHook(() =>
      useSwarmCreditCap({
        projectId: "project-1",
        organizationId: "org-1",
        environmentIds: ["env-1"],
        reusedGoals: [{ journeyId: "goal-1", sessions: 3 }],
        maxTurns: 6,
      }),
    );
    // 3 reused conversations at 20 leave 80: four new ones.
    expect(result.current.max).toBe(7);
  });

  it("gives no cap while the wallet is locked for review", () => {
    balance = { ...balance!, walletLocked: true };
    expect(render().result.current.max).toBeNull();
  });
});
