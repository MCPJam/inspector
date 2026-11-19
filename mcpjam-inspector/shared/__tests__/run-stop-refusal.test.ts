import { describe, expect, it } from "vitest";
import {
  isCreditExhaustion,
  recoveryForStopCode,
  runStopRefusal,
} from "../credit-exhaustion.js";

const BUDGET_URL = "https://app.mcpjam.com/organizations/org_paid/budget";

const budgetBody = (recovery?: Record<string, unknown>) => ({
  ok: false,
  code: "spend_budget_reached",
  refusalReason: "budget_reached",
  error: "This organization's spend budget is reached.",
  retryAfter: 0,
  ...(recovery ? { recovery } : {}),
});

const lockBody = (recovery?: Record<string, unknown>) => ({
  ok: false,
  code: "user_rate_limit",
  refusalReason: "wallet_locked",
  error: "Out of MCPJam credits.",
  ...(recovery ? { recovery } : {}),
});

/** How the runner holds a refusal: the sentence and the raw body. */
const held = (body: { error: string }) => ({
  message: body.error,
  details: JSON.stringify(body),
});

describe("runStopRefusal — spend budget", () => {
  it("stops the run with the backend's raise-budget step and link", () => {
    const recovery = {
      version: 1,
      reason: "budget_reached",
      action: "raise_budget",
      actor: "owner_or_admin",
      url: BUDGET_URL,
      resetAt: 1_800_000_000_000,
    };
    expect(isCreditExhaustion(held(budgetBody(recovery)))).toBe(false);
    expect(runStopRefusal(held(budgetBody(recovery)))).toEqual({ recovery });
  });

  it("names the raise-budget step without a link when the envelope has none", () => {
    expect(runStopRefusal(held(budgetBody()))).toEqual({
      recovery: {
        version: 1,
        reason: "budget_reached",
        action: "raise_budget",
        actor: "owner_or_admin",
      },
    });
  });

  it("never carries a purchase step on a spend budget", () => {
    const buy = {
      version: 1,
      reason: "budget_reached",
      action: "buy_credits",
      actor: "caller",
      url: "https://app.mcpjam.com/organizations/org_paid/billing?topup=open",
    };
    const stop = runStopRefusal(held(budgetBody(buy)));
    expect(stop?.recovery?.action).toBe("raise_budget");
    expect(stop?.recovery).not.toHaveProperty("url");
  });

  it("reads a legacy code-only refusal", () => {
    expect(
      runStopRefusal("ORGANIZATION_SPEND_BUDGET_REACHED")?.recovery?.action,
    ).toBe("raise_budget");
  });
});

describe("runStopRefusal — locked wallet", () => {
  it("stops the run with contact support and no link", () => {
    expect(runStopRefusal(held(lockBody()))).toEqual({
      recovery: {
        version: 1,
        reason: "wallet_locked",
        action: "contact_support",
        actor: "support",
      },
    });
  });

  it("replaces an upgrade step the backend attached to a lock", () => {
    const upgrade = {
      version: 1,
      reason: "wallet_locked",
      action: "upgrade_plan",
      actor: "caller",
      plan: "pro",
      url: "https://app.mcpjam.com/organizations/org_free/plans",
    };
    const stop = runStopRefusal(held(lockBody(upgrade)));
    expect(stop?.recovery).toEqual({
      version: 1,
      reason: "wallet_locked",
      action: "contact_support",
      actor: "support",
    });
  });
});

describe("runStopRefusal — not a stop", () => {
  it("leaves a hold to its retry", () => {
    const hold = {
      ok: false,
      code: "user_rate_limit",
      refusalReason: "holds_committed",
      error:
        "MCPJam model limit reached for the moment: 2 in-flight request(s) hold the remaining credits and release them as they finish.",
    };
    expect(runStopRefusal(held(hold))).toBeUndefined();
  });

  it("ignores the customer's own provider error", () => {
    expect(
      runStopRefusal({ code: "provider_quota", message: "wallet_locked" }),
    ).toBeUndefined();
  });

  it("ignores an unrelated error", () => {
    expect(runStopRefusal(new Error("socket hang up"))).toBeUndefined();
  });
});

describe("recoveryForStopCode", () => {
  const raise = {
    version: 1 as const,
    reason: "budget_reached",
    action: "raise_budget" as const,
    actor: "caller" as const,
    url: BUDGET_URL,
  };

  it("keeps a spend limit's own step beside its code", () => {
    expect(recoveryForStopCode("spend_budget_reached", raise)).toEqual(raise);
  });

  it("drops a purchase step beside a spend-limit code", () => {
    expect(
      recoveryForStopCode("wallet_locked", { ...raise, action: "buy_credits" }),
    ).toBeUndefined();
  });

  it("carries nothing beside an unrelated code", () => {
    expect(recoveryForStopCode("session_failed", raise)).toBeUndefined();
  });
});
