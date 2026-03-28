import { ConvexError } from "convex/values";
import { describe, expect, it } from "vitest";
import {
  getBillingErrorMessage,
  getDisplayPriceCentsForPlan,
  isGateAccessDenied,
  isPremiumnessGateDeniedForShell,
  MARKETING_PLAN_PRICE_CENTS_USD,
} from "../billing-entitlements";
import type {
  PlanCatalogEntry,
  PremiumnessState,
} from "@/hooks/useOrganizationBilling";

const minimalCatalogEntry = (prices: PlanCatalogEntry["prices"]): PlanCatalogEntry =>
  ({
    plan: "starter",
    displayName: "Starter",
    isSelfServe: true,
    prices,
    features: {} as PlanCatalogEntry["features"],
    limits: {} as PlanCatalogEntry["limits"],
  }) as PlanCatalogEntry;

function premiumness(
  overrides: Partial<PremiumnessState> & {
    gates?: PremiumnessState["gates"];
  } = {},
): PremiumnessState {
  return {
    enforcementState: "enabled",
    effectivePlan: "free",
    gates: {},
    ...overrides,
  };
}

describe("getBillingErrorMessage", () => {
  it("formats backend limit payloads for monthly eval runs", () => {
    const message = getBillingErrorMessage(
      new Error(
        JSON.stringify({
          code: "billing_limit_reached",
          limit: "maxEvalRunsPerMonth",
          allowedValue: 500,
        }),
      ),
      "fallback",
    );

    expect(message).toBe(
      "This organization has reached its monthly eval run limit (500). Upgrade to continue.",
    );
  });

  it("formats backend limit payloads for non-billing-admin users", () => {
    const message = getBillingErrorMessage(
      new Error(
        JSON.stringify({
          code: "billing_limit_reached",
          limit: "maxEvalRunsPerMonth",
          allowedValue: 500,
        }),
      ),
      "fallback",
      false,
    );

    expect(message).toBe(
      "This organization has reached its monthly eval run limit (500). Ask an organization owner to upgrade.",
    );
  });

  it("formats backend limit payloads for workspace sandboxes", () => {
    const message = getBillingErrorMessage(
      new Error(
        JSON.stringify({
          code: "billing_limit_reached",
          limit: "maxSandboxesPerWorkspace",
          allowedValue: 5,
        }),
      ),
      "fallback",
    );

    expect(message).toBe(
      "This workspace has reached its sandbox limit (5). Upgrade to continue.",
    );
  });

  it("formats billing_feature_not_included using gateKey when feature is absent", () => {
    const message = getBillingErrorMessage(
      new Error(
        JSON.stringify({
          code: "billing_feature_not_included",
          gateKey: "evals",
          upgradePlan: "starter",
        }),
      ),
      "fallback",
    );

    expect(message).toContain("Generate Evals");
    expect(message).toContain("Starter");
  });

  it("preserves non-billing ConvexError messages", () => {
    const error = new ConvexError({
      code: "rate_limited",
      retryAfter: 5,
    });
    error.message = 'ConvexError: {"code":"rate_limited","retryAfter":5}';

    const message = getBillingErrorMessage(error, "fallback");

    expect(message).toBe('ConvexError: {"code":"rate_limited","retryAfter":5}');
  });
});

describe("isGateAccessDenied", () => {
  it("treats enforcement disabled as never locked (soft mode)", () => {
    expect(
      isGateAccessDenied(
        premiumness({
          enforcementState: "disabled",
          gates: {
            evals: { allowed: false, gateKey: "evals" },
          },
        }),
        "evals",
      ),
    ).toBe(false);
  });

  it("denies when enforcement is enabled and the gate decision disallows", () => {
    expect(
      isGateAccessDenied(
        premiumness({
          gates: {
            evals: { allowed: false, gateKey: "evals", upgradePlan: "starter" },
          },
        }),
        "evals",
      ),
    ).toBe(true);
  });
});

describe("getDisplayPriceCentsForPlan", () => {
  it("returns marketing cents for Starter and Team regardless of catalog drift", () => {
    const drifted = minimalCatalogEntry({
      monthly: 5900,
      annual: 29000,
    });
    expect(getDisplayPriceCentsForPlan("starter", "annual", drifted)).toBe(
      MARKETING_PLAN_PRICE_CENTS_USD.starter.annual,
    );
    expect(getDisplayPriceCentsForPlan("team", "monthly", drifted)).toBe(
      MARKETING_PLAN_PRICE_CENTS_USD.team.monthly,
    );
  });

  it("falls back to catalog for other plans", () => {
    const entry = minimalCatalogEntry({ monthly: null, annual: null });
    expect(getDisplayPriceCentsForPlan("free", "monthly", entry)).toBeNull();
  });
});

describe("isPremiumnessGateDeniedForShell", () => {
  it("prefers workspace premiumness when a workspace exists", () => {
    const denied = isPremiumnessGateDeniedForShell({
      billingUiEnabled: true,
      hasWorkspace: true,
      gateKey: "evals",
      workspacePremiumness: premiumness({
        gates: {
          evals: { allowed: false, gateKey: "evals" },
        },
      }),
      organizationPremiumness: premiumness({
        gates: {
          evals: { allowed: true, gateKey: "evals" },
        },
      }),
    });
    expect(denied).toBe(true);
  });
});
