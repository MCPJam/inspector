import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { OrganizationBillingStatus } from "@/hooks/useOrganizationBilling";
import {
  OrganizationCurrentPlanPanel,
  getCurrentPlanRenewalLine,
  isEnterpriseBilledOffline,
} from "../OrganizationCurrentPlanPanel";

function makeStatus(
  overrides: Partial<OrganizationBillingStatus> = {},
): OrganizationBillingStatus {
  return {
    organizationId: "org-1",
    organizationName: "Acme",
    plan: "enterprise",
    effectivePlan: "enterprise",
    source: "subscription",
    billingInterval: null,
    billingConfigured: true,
    subscriptionStatus: null,
    canManageBilling: true,
    canCancelScheduledBillingChange: false,
    isOwner: true,
    hasCustomer: false,
    stripeScheduledPlan: null,
    stripeScheduledBillingInterval: null,
    stripeScheduledPriceId: null,
    stripeScheduledEffectiveAt: null,
    stripeCancelAtPeriodEnd: false,
    stripeCancelAt: null,
    stripeCanceledAt: null,
    stripeCurrentPeriodEnd: null,
    stripePriceId: null,
    trialStatus: "none",
    trialPlan: null,
    trialStartedAt: null,
    trialEndsAt: null,
    trialDaysRemaining: null,
    decisionRequired: false,
    trialDecision: null,
    ...overrides,
  };
}

function renderPanel(status: OrganizationBillingStatus) {
  return render(
    <OrganizationCurrentPlanPanel
      billingStatus={status}
      planCatalog={undefined}
      isLoadingPlanCatalog={false}
      onChangeBillingInterval={vi.fn()}
      onManageBilling={vi.fn()}
      isOpeningPortal={false}
    />,
  );
}

describe("OrganizationCurrentPlanPanel: Enterprise without Stripe", () => {
  it("says the plan is managed by MCPJam, not that nothing is active", () => {
    const status = makeStatus();
    expect(isEnterpriseBilledOffline(status)).toBe(true);
    expect(getCurrentPlanRenewalLine(status, "", "", "")).toBe(
      "Managed by MCPJam",
    );

    renderPanel(status);
    expect(screen.getByTestId("current-plan-renewal")).toHaveTextContent(
      "Managed by MCPJam",
    );
    expect(screen.queryByText("No active subscription")).toBeNull();
    // No Stripe customer means no portal to open.
    expect(screen.queryByRole("button", { name: "Manage billing" })).toBeNull();
  });

  it("keeps the Stripe wording for an Enterprise org that has a customer", () => {
    const status = makeStatus({
      hasCustomer: true,
      stripeCurrentPeriodEnd: Date.UTC(2027, 0, 15),
    });
    expect(isEnterpriseBilledOffline(status)).toBe(false);
    renderPanel(status);
    expect(screen.getByTestId("current-plan-renewal")).toHaveTextContent(
      /^Renews /,
    );
    expect(
      screen.getByRole("button", { name: "Manage billing" }),
    ).toBeInTheDocument();
  });

  it("still says No active subscription for other plans without a customer", () => {
    const status = makeStatus({ plan: "team", effectivePlan: "team" });
    expect(getCurrentPlanRenewalLine(status, "", "", "")).toBe(
      "No active subscription",
    );
  });
});
