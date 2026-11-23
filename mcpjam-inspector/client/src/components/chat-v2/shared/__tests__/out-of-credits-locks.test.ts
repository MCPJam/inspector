import { describe, expect, it } from "vitest";
import {
  allModelsOutOfCredits,
  applyOutOfCreditsLocks,
  isOutOfCreditsLocked,
  orgKeysDisallowedRow,
  OUT_OF_CREDITS_MODEL_REASON,
} from "../available-models";
import {
  isOutOfCredits,
  type CreditBalanceState,
} from "@/hooks/useCreditBalance";
import type { ModelDefinition } from "@/shared/types";

const EMPTY_LOCK = {
  reason: "Out of MCPJam credits · resets in 3h",
  belowCallMinimum: false,
};

const makeBalance = (
  overrides: Partial<CreditBalanceState> = {}
): CreditBalanceState => ({
  paidCreditsRemaining: 0,
  hasPurchaseHistory: false,
  freeDailyPercentUsed: 100,
  freeDailyResetAt: 0,
  freeDailyCreditsRemaining: 0,
  freeDailyCreditsTotal: 300,
  walletLocked: false,
  billingModel: "daily",
  ...overrides,
});

describe("isOutOfCredits", () => {
  it("is false when the balance is unavailable (loading / signed out)", () => {
    expect(isOutOfCredits(undefined)).toBe(false);
  });

  it("on a daily plan, is true only once both free daily and paid are spent", () => {
    expect(
      isOutOfCredits(
        makeBalance({ freeDailyCreditsRemaining: 0, paidCreditsRemaining: 0 })
      )
    ).toBe(true);
    expect(
      isOutOfCredits(
        makeBalance({ freeDailyCreditsRemaining: 0, paidCreditsRemaining: 5 })
      )
    ).toBe(false);
    expect(
      isOutOfCredits(
        makeBalance({ freeDailyCreditsRemaining: 12, paidCreditsRemaining: 0 })
      )
    ).toBe(false);
  });

  it("on a team plan, uses the monthly allowance instead of the daily bucket", () => {
    expect(
      isOutOfCredits(
        makeBalance({
          billingModel: "monthly_per_seat",
          monthlyAllowanceRemaining: 0,
          paidCreditsRemaining: 0,
          // A leftover daily figure must not keep a monthly team "in credits".
          freeDailyCreditsRemaining: 50,
        })
      )
    ).toBe(true);
    expect(
      isOutOfCredits(
        makeBalance({
          billingModel: "monthly_per_seat",
          monthlyAllowanceRemaining: 100,
          paidCreditsRemaining: 0,
        })
      )
    ).toBe(false);
  });
});

const model = (id: string, provider = "anthropic"): ModelDefinition =>
  ({ id, name: id, provider } as ModelDefinition);

describe("applyOutOfCreditsLocks", () => {
  const models = [
    model("anthropic/claude-haiku-4.5"), // MCPJam-provided (free)
    model("anthropic/claude-opus-4.5"), // MCPJam-provided (free)
    model("amazon.nova-micro-v1:0", "bedrock"), // own-key / BYOK
    model("openai/gpt-5-mini", "openrouter"), // own-key / BYOK with a provider-prefixed id
    model("custom:acme:acme-large", "custom"), // custom provider
  ];

  it("returns the list untouched when the user still has credits", () => {
    expect(applyOutOfCreditsLocks(models, null)).toBe(models);
  });

  it("locks only the MCPJam-provided (free) models when out of credits", () => {
    const locked = applyOutOfCreditsLocks(models, EMPTY_LOCK);
    const byId = Object.fromEntries(locked.map((m) => [String(m.id), m]));

    expect(byId["anthropic/claude-haiku-4.5"].disabled).toBe(true);
    expect(byId["anthropic/claude-haiku-4.5"].disabledReason).toBe(
      OUT_OF_CREDITS_MODEL_REASON
    );
    expect(byId["anthropic/claude-opus-4.5"].disabled).toBe(true);

    // Own-key models stay usable — switching to them is the way out.
    expect(byId["amazon.nova-micro-v1:0"].disabled).toBeUndefined();
    expect(byId["openai/gpt-5-mini"].disabled).toBeUndefined();
    expect(byId["custom:acme:acme-large"].disabled).toBeUndefined();
  });

  it("gives the rows the run button's text below the per-call minimum", () => {
    const reason =
      "Not enough MCPJam credits · a model call needs at least 4 · resets in 3h";
    const locked = applyOutOfCreditsLocks(models, {
      reason,
      belowCallMinimum: true,
    });
    const haiku = locked.find((m) => m.id === "anthropic/claude-haiku-4.5");

    expect(haiku?.disabled).toBe(true);
    expect(haiku?.disabledReason).toBe(reason);
    expect(isOutOfCreditsLocked(haiku)).toBe(true);
  });

  it("drops the credit lock when the organization policy locks the row", () => {
    const [creditLocked] = applyOutOfCreditsLocks(
      [model("anthropic/claude-haiku-4.5")],
      EMPTY_LOCK
    );
    const policyLocked = orgKeysDisallowedRow(creditLocked);

    expect(policyLocked.disabled).toBe(true);
    expect(isOutOfCreditsLocked(policyLocked)).toBe(false);
  });
});

describe("allModelsOutOfCredits", () => {
  const locked = (id: string, provider: string) => ({
    id,
    provider,
    disabledReasonCode: "out_of_credits" as const,
  });
  const models = [
    locked("anthropic/claude-haiku-4.5", "anthropic"),
    locked("openai/gpt-5-mini", "openai"),
    // A BYOK model: never locked for MCPJam credits.
    { id: "custom:acme:acme-large", provider: "custom" },
  ];

  it("is true only when every model the run uses is locked", () => {
    expect(
      allModelsOutOfCredits(
        [
          { model: "anthropic/claude-haiku-4.5", provider: "anthropic" },
          { model: "openai/gpt-5-mini", provider: "openai" },
        ],
        models
      )
    ).toBe(true);
    expect(
      allModelsOutOfCredits(
        [
          { model: "anthropic/claude-haiku-4.5", provider: "anthropic" },
          { model: "custom:acme:acme-large", provider: "custom" },
        ],
        models
      )
    ).toBe(false);
  });

  it("keeps a run with no known model, or an unknown one, available", () => {
    expect(allModelsOutOfCredits([], models)).toBe(false);
    expect(
      allModelsOutOfCredits([{ model: "some/unlisted-model" }], models)
    ).toBe(false);
  });

  it("never blocks a model a usable BYOK row shares an id with", () => {
    const shared = [
      locked("gpt-5-mini", "openai"),
      { id: "gpt-5-mini", provider: "azure" },
    ];
    // The BYOK row is the one this run names.
    expect(
      allModelsOutOfCredits([{ model: "gpt-5-mini", provider: "azure" }], shared)
    ).toBe(false);
    // No provider to tell them apart: one usable row is enough.
    expect(allModelsOutOfCredits([{ model: "gpt-5-mini" }], shared)).toBe(
      false
    );
    // The hosted row is the one this run names.
    expect(
      allModelsOutOfCredits(
        [{ model: "gpt-5-mini", provider: "openai" }],
        shared
      )
    ).toBe(true);
  });

  it("never blocks a provider that has no row of its own", () => {
    expect(
      allModelsOutOfCredits(
        [{ model: "anthropic/claude-haiku-4.5", provider: "bedrock" }],
        models
      )
    ).toBe(false);
  });

  it("matches an older case's model saved without its provider prefix", () => {
    expect(
      allModelsOutOfCredits(
        [{ model: "claude-haiku-4.5", provider: "anthropic" }],
        models
      )
    ).toBe(true);
  });

  it("matches the lock by its code, whatever the row says", () => {
    const [belowMinimum] = applyOutOfCreditsLocks(
      [model("anthropic/claude-haiku-4.5")],
      {
        reason:
          "Not enough MCPJam credits · a model call needs at least 4 · resets in 3h",
        belowCallMinimum: true,
      }
    );
    expect(
      allModelsOutOfCredits(
        [{ model: "anthropic/claude-haiku-4.5", provider: "anthropic" }],
        [belowMinimum]
      )
    ).toBe(true);
    // The out-of-credits text on a row some other lock set is not this lock.
    expect(
      allModelsOutOfCredits(
        [{ model: "anthropic/claude-haiku-4.5", provider: "anthropic" }],
        [
          {
            id: "anthropic/claude-haiku-4.5",
            provider: "anthropic",
            disabledReason: OUT_OF_CREDITS_MODEL_REASON,
          },
        ]
      )
    ).toBe(false);
  });
});
