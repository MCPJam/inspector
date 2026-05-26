import { renderHook } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const {
  mockUseConvexAuth,
  mockUseFeatureFlagEnabled,
  mockUseOrganizationBilling,
} = vi.hoisted(() => ({
  mockUseConvexAuth: vi.fn(),
  mockUseFeatureFlagEnabled: vi.fn(),
  mockUseOrganizationBilling: vi.fn(),
}));

vi.mock("convex/react", () => ({
  useConvexAuth: (...args: unknown[]) => mockUseConvexAuth(...args),
}));

vi.mock("posthog-js/react", () => ({
  useFeatureFlagEnabled: (...args: unknown[]) =>
    mockUseFeatureFlagEnabled(...args),
}));

vi.mock("@/hooks/useOrganizationBilling", () => ({
  useOrganizationBilling: (...args: unknown[]) =>
    mockUseOrganizationBilling(...args),
}));

import {
  BILLING_GATES,
  resolveBillingGateState,
  useProjectBillingGate,
} from "../billing-gates";

function createUseOrganizationBillingResult() {
  return {
    billingStatus: undefined,
    organizationPremiumness: undefined,
    projectPremiumness: undefined,
    isLoadingBilling: false,
    isLoadingOrganizationPremiumness: false,
    isLoadingProjectPremiumness: false,
  };
}

describe("resolveBillingGateState", () => {
  beforeEach(() => {
    mockUseConvexAuth.mockReturnValue({
      isAuthenticated: true,
    });
    mockUseFeatureFlagEnabled.mockReturnValue(true);
    mockUseOrganizationBilling.mockReturnValue(
      createUseOrganizationBillingResult(),
    );
  });

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
            gateKey: "chatboxes",
            kind: "feature",
            scope: "organization",
            canAccess: false,
            shouldShowUpsell: true,
            upgradePlan: "team",
            reason: "feature_not_included",
          },
        ],
      },
      gate: BILLING_GATES.chatboxes,
    });

    expect(gate.isDenied).toBe(true);
    expect(gate.currentPlan).toBe("free");
    expect(gate.upgradePlan).toBe("team");
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
      },
      gate: BILLING_GATES.projectCreation,
    });

    expect(gate.isDenied).toBe(true);
    expect(gate.denialMessage).toBe(
      "This organization has reached its project limit (1). Upgrade to create more projects.",
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
            gateKey: "chatboxes",
            kind: "feature",
            scope: "organization",
            canAccess: false,
            shouldShowUpsell: true,
            upgradePlan: "team",
            reason: "feature_not_included",
          },
        ],
      },
      gate: BILLING_GATES.chatboxes,
    });

    expect(gate.isDenied).toBe(false);
    expect(gate.upgradePlan).toBe("team");
  });

  it("skips project billing queries when organization context is missing", () => {
    const { result } = renderHook(() =>
      useProjectBillingGate({
        projectId: "shared-ws-1",
        organizationId: null,
        gate: BILLING_GATES.serverCreation,
      }),
    );

    expect(mockUseOrganizationBilling).toHaveBeenCalledWith(null, {
      projectId: null,
    });
    expect(result.current.organizationId).toBeNull();
    expect(result.current.isLoading).toBe(false);
  });

  it("only resolves project billing when both project and organization are present", () => {
    renderHook(() =>
      useProjectBillingGate({
        projectId: "shared-ws-1",
        organizationId: "org-1",
        gate: BILLING_GATES.serverCreation,
      }),
    );

    expect(mockUseOrganizationBilling).toHaveBeenCalledWith("org-1", {
      projectId: "shared-ws-1",
    });
  });
});
