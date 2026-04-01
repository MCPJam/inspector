import { ConvexError } from "convex/values";
import { describe, expect, it } from "vitest";
import {
  getBillingErrorMessage,
  getDisplayPriceCentsForPlan,
  isGateAccessDenied,
  isPremiumnessGateDeniedForShell,
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
    plan: "free",
    enforcementState: "active",
    effectivePlan: "free",
    billingInterval: null,
    source: "free",
    decisionRequired: false,
    gates: [],
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

  it("formats backend limit payloads for organization members", () => {
    const message = getBillingErrorMessage(
      new Error(
        JSON.stringify({
          code: "billing_limit_reached",
          limit: "maxMembers",
          allowedValue: 3,
        }),
      ),
      "fallback",
    );

    expect(message).toBe(
      "This organization has reached its member limit (3). Upgrade to add more members.",
    );
  });

  it("formats member-limit payloads for non-billing-admin users", () => {
    const message = getBillingErrorMessage(
      new Error(
        JSON.stringify({
          code: "billing_limit_reached",
          limit: "maxMembers",
          allowedValue: 3,
        }),
      ),
      "fallback",
      false,
    );

    expect(message).toBe(
      "This organization has reached its member limit (3). Ask an organization owner to upgrade.",
    );
  });

  it("formats backend limit payloads for workspaces", () => {
    const message = getBillingErrorMessage(
      new Error(
        JSON.stringify({
          code: "billing_limit_reached",
          limit: "maxWorkspaces",
          allowedValue: 1,
        }),
      ),
      "fallback",
    );

    expect(message).toBe(
      "This organization has reached its workspace limit (1). Upgrade to create more workspaces.",
    );
  });

  it("formats workspace-limit payloads for non-billing-admin users", () => {
    const message = getBillingErrorMessage(
      new Error(
        JSON.stringify({
          code: "billing_limit_reached",
          limit: "maxWorkspaces",
          allowedValue: 1,
        }),
      ),
      "fallback",
      false,
    );

    expect(message).toBe(
      "This organization has reached its workspace limit (1). Ask an organization owner to upgrade.",
    );
  });

  it("formats billing_feature_not_included using the current plan name", () => {
    const message = getBillingErrorMessage(
      new Error(
        JSON.stringify({
          code: "billing_feature_not_included",
          feature: "sandboxes",
          plan: "free",
          upgradePlan: "starter",
        }),
      ),
      "fallback",
    );

    expect(message).toBe(
      "Sandboxes is not included in the Free plan. Upgrade to Starter to continue.",
    );
  });

  it("formats billing_feature_not_included for non-billing admins with explicit upgrade guidance", () => {
    const message = getBillingErrorMessage(
      new Error(
        JSON.stringify({
          code: "billing_feature_not_included",
          feature: "sandboxes",
          plan: "free",
          upgradePlan: "starter",
        }),
      ),
      "fallback",
      false,
    );

    expect(message).toBe(
      "Sandboxes is not included in the Free plan. Ask an organization owner to upgrade to Starter.",
    );
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
          gates: [
            {
              gateKey: "evals",
              kind: "feature",
              scope: "workspace",
              canAccess: false,
              shouldShowUpsell: true,
              upgradePlan: "starter",
              reason: "feature_not_included",
            },
          ],
        }),
        "evals",
      ),
    ).toBe(false);
  });

  it("denies when enforcement is enabled and the gate decision disallows", () => {
    expect(
      isGateAccessDenied(
        premiumness({
          gates: [
            {
              gateKey: "evals",
              kind: "feature",
              scope: "workspace",
              canAccess: false,
              shouldShowUpsell: true,
              upgradePlan: "starter",
              reason: "feature_not_included",
            },
          ],
        }),
        "evals",
      ),
    ).toBe(true);
  });

  it("denies maxWorkspaces when a free organization is already at cap", () => {
    expect(
      isGateAccessDenied(
        premiumness({
          gates: [
            {
              gateKey: "maxWorkspaces",
              kind: "limit",
              scope: "organization",
              canAccess: false,
              shouldShowUpsell: true,
              upgradePlan: "starter",
              reason: "limit_reached",
              currentValue: 1,
              allowedValue: 1,
            },
          ],
        }),
        "maxWorkspaces",
      ),
    ).toBe(true);
  });
});

describe("getDisplayPriceCentsForPlan", () => {
  it("returns catalog cents for Starter and Team", () => {
    const drifted = minimalCatalogEntry({
      monthly: 6100,
      annual: 29000,
    });
    expect(getDisplayPriceCentsForPlan("starter", "annual", drifted)).toBe(
      29000,
    );
    expect(getDisplayPriceCentsForPlan("team", "monthly", drifted)).toBe(
      6100,
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
        gates: [
          {
            gateKey: "evals",
            kind: "feature",
            scope: "workspace",
            canAccess: false,
            shouldShowUpsell: true,
            upgradePlan: "starter",
            reason: "feature_not_included",
          },
        ],
      }),
      organizationPremiumness: premiumness({
        gates: [
          {
            gateKey: "evals",
            kind: "feature",
            scope: "workspace",
            canAccess: true,
            shouldShowUpsell: false,
            upgradePlan: null,
            reason: "feature_included",
          },
        ],
      }),
    });
    expect(denied).toBe(true);
  });
});
