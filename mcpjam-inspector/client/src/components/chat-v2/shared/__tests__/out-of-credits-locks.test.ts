import { describe, expect, it } from "vitest";
import {
  allModelsOutOfCredits,
  applyOutOfCreditsLocks,
  OUT_OF_CREDITS_MODEL_REASON,
} from "../available-models";
import {
  isOutOfCredits,
  type CreditBalanceState,
} from "@/hooks/useCreditBalance";
import type { ModelDefinition } from "@/shared/types";

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
    expect(applyOutOfCreditsLocks(models, false)).toBe(models);
  });

  it("locks only the MCPJam-provided (free) models when out of credits", () => {
    const locked = applyOutOfCreditsLocks(models, true);
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
});

describe("allModelsOutOfCredits", () => {
  const locked = (id: string, provider: string) => ({
    id,
    provider,
    disabledReason: OUT_OF_CREDITS_MODEL_REASON,
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

  it("matches an older case's model saved without its provider prefix", () => {
    expect(
      allModelsOutOfCredits(
        [{ model: "claude-haiku-4.5", provider: "anthropic" }],
        models
      )
    ).toBe(true);
  });
});
