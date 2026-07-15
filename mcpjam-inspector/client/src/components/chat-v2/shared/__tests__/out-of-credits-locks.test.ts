import { describe, expect, it } from "vitest";
import {
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
