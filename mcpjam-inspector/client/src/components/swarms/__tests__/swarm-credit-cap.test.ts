import { describe, expect, it } from "vitest";
import type { CreditBalanceState } from "@/hooks/useCreditBalance";
import {
  capGeneration,
  generationSize,
  iterationsThatFit,
  maxConversations,
  nextStepFits,
  usableCredits,
  type ConversationEstimate,
} from "../swarm-credit-cap";

const daily = (
  overrides: Partial<CreditBalanceState> = {},
): CreditBalanceState => ({
  paidCreditsRemaining: 0,
  hasPurchaseHistory: false,
  freeDailyPercentUsed: 0,
  freeDailyResetAt: 0,
  freeDailyCreditsRemaining: 0,
  freeDailyCreditsTotal: 300,
  walletLocked: false,
  billingModel: "daily",
  ...overrides,
});

const env = (
  overrides: Partial<ConversationEstimate> = {},
): ConversationEstimate => ({
  environmentId: "env-1",
  tokenCredits: 20,
  feeCredits: 0,
  freeEligible: false,
  ...overrides,
});

describe("usableCredits", () => {
  it("adds the daily bucket to paid credits", () => {
    expect(
      usableCredits(
        daily({ freeDailyCreditsRemaining: 90, paidCreditsRemaining: 50 }),
      ),
    ).toBe(140);
  });

  it("uses the monthly allowance on monthly plans", () => {
    expect(
      usableCredits(
        daily({
          billingModel: "monthly_flat",
          freeDailyCreditsRemaining: 300,
          monthlyAllowanceRemaining: 100,
          paidCreditsRemaining: 40,
        }),
      ),
    ).toBe(140);
  });

  it("takes the per-call floor off each pool, never below zero", () => {
    expect(
      usableCredits(
        daily({
          freeDailyCreditsRemaining: 300,
          paidCreditsRemaining: 10,
          perCallMinimumCredits: 25,
        }),
      ),
    ).toBe(275);
  });

  it("is zero while the wallet is locked", () => {
    expect(
      usableCredits(
        daily({ freeDailyCreditsRemaining: 300, walletLocked: true }),
      ),
    ).toBe(0);
  });
});

describe("maxConversations", () => {
  it.each([
    ["credits only", 140, 0, [env()], 7],
    ["mixed free and credits", 60, 4, [env({ freeEligible: true })], 7],
    ["free conversations the launch would not sponsor", 60, 4, [env()], 3],
    ["not enough for one", 12, 0, [env()], 0],
    [
      "two environments per slot",
      100,
      0,
      [env(), env({ environmentId: "env-2", tokenCredits: 30 })],
      4,
    ],
    ["the per-turn fee", 140, 0, [env({ tokenCredits: 6, feeCredits: 30 })], 3],
  ] as const)("%s", (_name, usable, freeLeft, perEnvironment, expected) => {
    expect(maxConversations({ usable, freeLeft, perEnvironment })).toBe(
      expected,
    );
  });

  it("gives no cap when an environment is unpriced", () => {
    expect(
      maxConversations({
        usable: 140,
        freeLeft: 0,
        perEnvironment: [env(), env({ tokenCredits: null })],
      }),
    ).toBeNull();
  });

  it("gives no cap when no conversation costs credits", () => {
    expect(
      maxConversations({
        usable: 0,
        freeLeft: 0,
        perEnvironment: [env({ tokenCredits: 0 })],
      }),
    ).toBeNull();
  });
});

describe("maxConversations with reused goals", () => {
  it("pays for reused goals first and adds the new slots that still fit", () => {
    // 2 reused conversations at 20 leave 100: five new ones.
    expect(
      maxConversations({
        usable: 140,
        freeLeft: 0,
        perEnvironment: [env()],
        reused: [{ sessions: 2, perEnvironment: [env()] }],
      }),
    ).toBe(7);
  });

  it("caps at the reused conversations that fit when they alone are too many", () => {
    expect(
      maxConversations({
        usable: 50,
        freeLeft: 0,
        perEnvironment: [env()],
        reused: [{ sessions: 4, perEnvironment: [env()] }],
      }),
    ).toBe(2);
  });

  it("spends free conversations on reused goals before new ones", () => {
    expect(
      maxConversations({
        usable: 40,
        freeLeft: 1,
        perEnvironment: [env({ freeEligible: true })],
        reused: [
          { sessions: 1, perEnvironment: [env({ freeEligible: true })] },
        ],
      }),
    ).toBe(3);
  });

  it("gives no cap when a reused goal could not be read", () => {
    expect(
      maxConversations({
        usable: 140,
        freeLeft: 0,
        perEnvironment: [env()],
        reused: [{ sessions: 1, perEnvironment: null }],
      }),
    ).toBeNull();
  });
});

describe("generationSize", () => {
  const quick = {
    reusedConversations: 0,
    environmentCount: 1,
    iterations: 1,
    personaCount: 3,
    journeyCount: 5,
  };

  it("keeps the preset when there is no cap or it does not bind", () => {
    expect(generationSize({ ...quick, max: null })).toEqual({
      personaCount: 3,
      journeyCount: 5,
    });
    expect(generationSize({ ...quick, max: 15 })).toEqual({
      personaCount: 3,
      journeyCount: 5,
    });
  });

  it("keeps 3 personas and shrinks their goals", () => {
    expect(generationSize({ ...quick, max: 7 })).toEqual({
      personaCount: 3,
      journeyCount: 2,
    });
  });

  it("writes fewer personas when fewer goals fit than personas", () => {
    expect(generationSize({ ...quick, max: 2 })).toEqual({
      personaCount: 2,
      journeyCount: 1,
    });
  });

  it("counts reused conversations and every environment", () => {
    expect(
      generationSize({
        ...quick,
        max: 14,
        reusedConversations: 2,
        environmentCount: 2,
      }),
    ).toEqual({ personaCount: 3, journeyCount: 2 });
  });

  it("generates nothing when not one goal fits", () => {
    expect(generationSize({ ...quick, max: 0 })).toBeNull();
    expect(
      generationSize({ ...quick, max: 3, reusedConversations: 3 }),
    ).toBeNull();
  });
});

describe("nextStepFits", () => {
  it("allows a step that lands on the max and refuses one that passes it", () => {
    expect(nextStepFits({ count: 5, added: 2, max: 7 })).toBe(true);
    // The overshoot rule: 6 of 7, and a persona with 2 goals adds 2.
    expect(nextStepFits({ count: 6, added: 2, max: 7 })).toBe(false);
  });

  it("allows anything without a cap", () => {
    expect(nextStepFits({ count: 900, added: 50, max: null })).toBe(true);
  });
});

describe("iterationsThatFit", () => {
  it("clamps a persona's iterations to what the rest of the swarm leaves", () => {
    // 4 other conversations, 2 goals per iteration, max 7: one iteration.
    expect(
      iterationsThatFit({
        max: 7,
        otherConversations: 4,
        conversationsPerIteration: 2,
      }),
    ).toBe(1);
    expect(
      iterationsThatFit({
        max: 10,
        otherConversations: 2,
        conversationsPerIteration: 2,
      }),
    ).toBe(4);
  });

  it("never goes below one iteration, and has no limit without a cap", () => {
    expect(
      iterationsThatFit({
        max: 3,
        otherConversations: 5,
        conversationsPerIteration: 2,
      }),
    ).toBe(1);
    expect(
      iterationsThatFit({
        max: null,
        otherConversations: 0,
        conversationsPerIteration: 2,
      }),
    ).toBe(Number.POSITIVE_INFINITY);
  });
});

describe("capGeneration", () => {
  const preset = { personaCount: 3, journeyCount: 5 };

  it("binds only when the cap changes the preset", () => {
    expect(capGeneration({ max: null, environmentCount: 1, preset })).toEqual({
      size: preset,
      binds: false,
    });
    expect(capGeneration({ max: 7, environmentCount: 1, preset })).toEqual({
      size: { personaCount: 3, journeyCount: 2 },
      binds: true,
    });
    expect(capGeneration({ max: 0, environmentCount: 1, preset })).toEqual({
      size: null,
      binds: true,
    });
  });
});
