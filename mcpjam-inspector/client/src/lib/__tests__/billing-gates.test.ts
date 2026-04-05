import { describe, expect, it } from "vitest";
import { BILLING_GATES, resolveBillingGateState } from "../billing-gates";

describe("resolveBillingGateState", () => {
  it("resolves denied feature gates with upgrade guidance", () => {
    const gate = resolveBillingGateState({
      billingUiEnabled: true,
      organizationId: "org-1",
      billingStatus: {
        organizationId: "org-1",
        organizationName: "Org One",
        plan: "free",
        effectivePlan: "free",
        source: "free",
        billingInterval: null,
        billingConfigured: true,
        subscriptionStatus: null,
        canManageBilling: true,
        isOwner: true,
        hasCustomer: false,
        stripeCurrentPeriodEnd: null,
        stripePriceId: null,
        trialStatus: "none",
        trialPlan: null,
        trialStartedAt: null,
        trialEndsAt: null,
        trialDaysRemaining: null,
        decisionRequired: false,
        trialDecision: null,
      },
      premiumness: {
        plan: "free",
        effectivePlan: "free",
        billingInterval: null,
        source: "free",
        enforcementState: "active",
        decisionRequired: false,
        gates: [
          {
            gateKey: "sandboxes",
            kind: "feature",
            scope: "organization",
            canAccess: false,
            shouldShowUpsell: true,
            upgradePlan: "starter",
            reason: "feature_not_included",
          },
        ],
      },
      gate: BILLING_GATES.sandboxes,
    });

    expect(gate.isDenied).toBe(true);
    expect(gate.currentPlan).toBe("free");
    expect(gate.upgradePlan).toBe("starter");
    expect(gate.denialMessage).toBeNull();
  });

  it("formats limit gates through the shared resolver", () => {
    const gate = resolveBillingGateState({
      billingUiEnabled: true,
      organizationId: "org-1",
      billingStatus: {
        organizationId: "org-1",
        organizationName: "Org One",
        plan: "free",
        effectivePlan: "free",
        source: "free",
        billingInterval: null,
        billingConfigured: true,
        subscriptionStatus: null,
        canManageBilling: true,
        isOwner: true,
        hasCustomer: false,
        stripeCurrentPeriodEnd: null,
        stripePriceId: null,
        trialStatus: "none",
        trialPlan: null,
        trialStartedAt: null,
        trialEndsAt: null,
        trialDaysRemaining: null,
        decisionRequired: false,
        trialDecision: null,
      },
      premiumness: {
        plan: "free",
        effectivePlan: "free",
        billingInterval: null,
        source: "free",
        enforcementState: "active",
        decisionRequired: false,
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
      },
      gate: BILLING_GATES.workspaceCreation,
    });

    expect(gate.isDenied).toBe(true);
    expect(gate.denialMessage).toBe(
      "This organization has reached its workspace limit (1). Upgrade to create more workspaces.",
    );
  });

  it("ignores denied decisions when enforcement is disabled", () => {
    const gate = resolveBillingGateState({
      billingUiEnabled: true,
      organizationId: "org-1",
      premiumness: {
        plan: "free",
        effectivePlan: "free",
        billingInterval: null,
        source: "free",
        enforcementState: "disabled",
        decisionRequired: false,
        gates: [
          {
            gateKey: "sandboxes",
            kind: "feature",
            scope: "organization",
            canAccess: false,
            shouldShowUpsell: true,
            upgradePlan: "starter",
            reason: "feature_not_included",
          },
        ],
      },
      gate: BILLING_GATES.sandboxes,
    });

    expect(gate.isDenied).toBe(false);
    expect(gate.upgradePlan).toBe("starter");
  });
});
