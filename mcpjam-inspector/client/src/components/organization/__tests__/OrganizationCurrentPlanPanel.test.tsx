import { render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
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

  it("says managed by MCPJam even when a period end is present", () => {
    const status = makeStatus({ stripeCurrentPeriodEnd: Date.UTC(2027, 0, 15) });
    expect(getCurrentPlanRenewalLine(status, "Jan 15, 2027", "", "")).toBe(
      "Managed by MCPJam",
    );
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

describe("OrganizationCurrentPlanPanel: plan set by MCPJam staff", () => {
  // Midnight UTC after Dec 31, 2026: the exclusive end of a plan through Dec 31.
  const END_OF_2026 = Date.UTC(2027, 0, 1);

  function staffPlanStatus(expiresAt: number | null) {
    return makeStatus({
      plan: "free",
      effectivePlan: "team",
      source: "subscription",
      catalogPlanId: "team",
      priceModel: "flat",
      billingInterval: "monthly",
      hasCustomer: false,
      staffPlan: { expiresAt },
    });
  }

  function expectNoSubscriptionControls() {
    expect(screen.queryByText("Limited functionality")).toBeNull();
    expect(screen.queryByText(/Billing details are updating/)).toBeNull();
    expect(screen.queryByText(/flat monthly rate/)).toBeNull();
    expect(screen.queryByTestId("current-plan-renewal")).toBeNull();
    expect(screen.queryByTestId("current-plan-legacy-badge")).toBeNull();
    expect(screen.queryByRole("button", { name: "Manage billing" })).toBeNull();
    expect(screen.queryByRole("button", { name: /^Change to / })).toBeNull();
  }

  it("names the staff tier with no detail line when the plan has no end", () => {
    renderPanel(staffPlanStatus(null));
    const panel = screen.getByTestId("current-plan-panel");
    expect(screen.getByText("Team")).toBeInTheDocument();
    expect(screen.queryByText("Free")).toBeNull();
    expect(screen.queryByText(/^Through /)).toBeNull();
    expectNoSubscriptionControls();
    // The plan name is the only line under the badge row.
    expect(panel.querySelectorAll("p")).toHaveLength(1);
  });

  it("shows the last day of a plan that ends", () => {
    renderPanel(staffPlanStatus(END_OF_2026));
    expect(screen.getByText("Team")).toBeInTheDocument();
    expect(screen.getByText("Through Dec 31, 2026")).toBeInTheDocument();
    expectNoSubscriptionControls();
  });

  describe("in other timezones", () => {
    afterEach(() => {
      vi.unstubAllEnvs();
    });

    it.each([
      ["UTC+8", "Asia/Singapore", 1],
      ["UTC-8", "America/Los_Angeles", 31],
    ])("shows the same last day at %s", (_offset, timeZone, localDay) => {
      vi.stubEnv("TZ", timeZone);
      // The zone took effect: read locally, the last millisecond of the plan
      // falls on a different day in each zone.
      expect(new Date(END_OF_2026 - 1).getDate()).toBe(localDay);
      renderPanel(staffPlanStatus(END_OF_2026));
      expect(screen.getByText("Through Dec 31, 2026")).toBeInTheDocument();
    });
  });

  it("keeps today's Free card when there is no staff plan", () => {
    const freeStatus = makeStatus({
      plan: "free",
      effectivePlan: "free",
      source: "free",
    });
    const { container: withoutField, unmount } = renderPanel(freeStatus);
    expect(screen.getByText("Free")).toBeInTheDocument();
    expect(screen.getByText("Limited functionality")).toBeInTheDocument();
    const todayHtml = withoutField.innerHTML;
    unmount();

    for (const staffPlan of [null, undefined]) {
      const { container, unmount: unmountVariant } = renderPanel({
        ...freeStatus,
        staffPlan,
      });
      expect(container.innerHTML).toBe(todayHtml);
      unmountVariant();
    }
  });
});
