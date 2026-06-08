import { ConvexError } from "convex/values";
import { describe, expect, it } from "vitest";
import {
  BILLING_FEATURE_BY_TAB,
  getBillingErrorMessage,
  getDisplayPriceCentsForPlan,
  getPremiumnessGateForTab,
  getRequiredBillingFeatureForTab,
  isGateAccessDenied,
  isPremiumnessGateDeniedForShell,
} from "../billing-entitlements";
import type {
  PlanCatalogEntry,
  PremiumnessState,
} from "@/hooks/useOrganizationBilling";

const minimalCatalogEntry = (
  prices: PlanCatalogEntry["prices"],
): PlanCatalogEntry =>
  ({
    plan: "team",
    displayName: "Team",
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

describe("BILLING_FEATURE_BY_TAB", () => {
  it("maps the chatboxes tab to the chatboxes premiumness feature", () => {
    expect(BILLING_FEATURE_BY_TAB.chatboxes).toBe("chatboxes");
    expect(getRequiredBillingFeatureForTab("chatboxes")).toBe("chatboxes");
    expect(getPremiumnessGateForTab("chatboxes")).toBe("chatboxes");
  });
});

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

  it("formats backend limit payloads for project chatboxes", () => {
    const message = getBillingErrorMessage(
      new Error(
        JSON.stringify({
          code: "billing_limit_reached",
          limit: "maxChatboxesPerProject",
          allowedValue: 5,
        }),
      ),
      "fallback",
    );

    expect(message).toBe(
      "This project has reached its chatbox limit (5). Upgrade to continue.",
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

  it("formats backend limit payloads for projects", () => {
    const message = getBillingErrorMessage(
      new Error(
        JSON.stringify({
          code: "billing_limit_reached",
          limit: "maxProjects",
          allowedValue: 1,
        }),
      ),
      "fallback",
    );

    expect(message).toBe(
      "This organization has reached its project limit (1). Upgrade to create more projects.",
    );
  });

  it("formats project-limit payloads for non-billing-admin users", () => {
    const message = getBillingErrorMessage(
      new Error(
        JSON.stringify({
          code: "billing_limit_reached",
          limit: "maxProjects",
          allowedValue: 1,
        }),
      ),
      "fallback",
      false,
    );

    expect(message).toBe(
      "This organization has reached its project limit (1). Ask an organization owner to upgrade.",
    );
  });

  it("formats billing_feature_not_included using the current plan name", () => {
    const message = getBillingErrorMessage(
      new Error(
        JSON.stringify({
          code: "billing_feature_not_included",
          feature: "chatboxes",
          plan: "free",
          upgradePlan: "team",
        }),
      ),
      "fallback",
    );

    expect(message).toBe(
      "Chatboxes is not included in the Free plan. Upgrade to Team to continue.",
    );
  });

  it("formats billing_feature_not_included for non-billing admins with explicit upgrade guidance", () => {
    const message = getBillingErrorMessage(
      new Error(
        JSON.stringify({
          code: "billing_feature_not_included",
          feature: "chatboxes",
          plan: "free",
          upgradePlan: "team",
        }),
      ),
      "fallback",
      false,
    );

    expect(message).toBe(
      "Chatboxes is not included in the Free plan. Ask an organization owner to upgrade to Team.",
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
              scope: "project",
              canAccess: false,
              shouldShowUpsell: true,
              upgradePlan: "team",
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
              scope: "project",
              canAccess: false,
              shouldShowUpsell: true,
              upgradePlan: "team",
              reason: "feature_not_included",
            },
          ],
        }),
        "evals",
      ),
    ).toBe(true);
  });

  it("respects explicit denied maxProjects gate decisions", () => {
    expect(
      isGateAccessDenied(
        premiumness({
          gates: [
            {
              gateKey: "maxProjects",
              kind: "limit",
              scope: "organization",
              canAccess: false,
              shouldShowUpsell: true,
              upgradePlan: "team",
              reason: "limit_reached",
              currentValue: 1,
              allowedValue: 1,
            },
          ],
        }),
        "maxProjects",
      ),
    ).toBe(true);
  });

  it("allows chatboxes for enterprise when the gate decision grants access", () => {
    expect(
      isGateAccessDenied(
        premiumness({
          plan: "enterprise",
          effectivePlan: "enterprise",
          gates: [
            {
              gateKey: "chatboxes",
              kind: "feature",
              scope: "organization",
              canAccess: true,
              shouldShowUpsell: false,
              upgradePlan: null,
              reason: "feature_included",
            },
          ],
        }),
        "chatboxes",
      ),
    ).toBe(false);
  });
});

describe("getDisplayPriceCentsForPlan", () => {
  it("returns catalog cents for Team and Team", () => {
    const drifted = minimalCatalogEntry({
      monthly: 6100,
      annual: 29000,
    });
    expect(getDisplayPriceCentsForPlan("team", "annual", drifted)).toBe(
      29000,
    );
    expect(getDisplayPriceCentsForPlan("team", "monthly", drifted)).toBe(6100);
  });

  it("falls back to catalog for other plans", () => {
    const entry = minimalCatalogEntry({ monthly: null, annual: null });
    expect(getDisplayPriceCentsForPlan("free", "monthly", entry)).toBeNull();
  });
});

describe("isPremiumnessGateDeniedForShell", () => {
  it("prefers project premiumness when a project exists", () => {
    const denied = isPremiumnessGateDeniedForShell({
      billingUiEnabled: true,
      hasProject: true,
      gateKey: "evals",
      projectPremiumness: premiumness({
        gates: [
          {
            gateKey: "evals",
            kind: "feature",
            scope: "project",
            canAccess: false,
            shouldShowUpsell: true,
            upgradePlan: "team",
            reason: "feature_not_included",
          },
        ],
      }),
      organizationPremiumness: premiumness({
        gates: [
          {
            gateKey: "evals",
            kind: "feature",
            scope: "project",
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
