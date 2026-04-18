import { useState } from "react";
import { describe, expect, it, beforeEach, vi } from "vitest";
import {
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { toast } from "sonner";
import { OrganizationsTab } from "../OrganizationsTab";
import { useOrganizationBilling } from "@/hooks/useOrganizationBilling";
import type { CheckoutIntentWithOrganization } from "@/lib/billing-deep-link";

const mockUseAuth = vi.fn();
const mockUseConvexAuth = vi.fn();
const mockUseOrganizationQueries = vi.fn();
const mockUseOrganizationMembers = vi.fn();
const mockUseFeatureFlagEnabled = vi.fn();
const mockUseOrganizationBilling = vi.mocked(useOrganizationBilling);
const {
  addMemberMock,
  removeMemberMock,
  updateOrganizationMock,
  deleteOrganizationMock,
  changeMemberRoleMock,
  transferOrganizationOwnershipMock,
  generateLogoUploadUrlMock,
  updateOrganizationLogoMock,
} = vi.hoisted(() => ({
  addMemberMock: vi.fn(),
  removeMemberMock: vi.fn(),
  updateOrganizationMock: vi.fn(),
  deleteOrganizationMock: vi.fn(),
  changeMemberRoleMock: vi.fn(),
  transferOrganizationOwnershipMock: vi.fn(),
  generateLogoUploadUrlMock: vi.fn(),
  updateOrganizationLogoMock: vi.fn(),
}));

function createPlanCatalog() {
  return {
    catalogVersion: "mcpjam_pricing_page",
    currency: "usd",
    appOrigin: "http://localhost:5173",
    plans: {
      free: {
        plan: "free",
        displayName: "Free",
        billingModel: "free",
        isSelfServe: false,
        prices: { monthly: 0, annual: 0 },
        features: {
          evals: false,
          chatboxes: false,
          cicd: false,
          customDomains: false,
          auditLog: false,
          sso: false,
          prioritySupport: false,
        },
        limits: {
          maxMembers: 1,
          maxWorkspaces: 1,
          maxServersPerWorkspace: 3,
          maxChatboxesPerWorkspace: 0,
          maxEvalRunsPerMonth: 5,
        },
        includedSeats: null,
        seatMinimum: null,
        checkout: null,
      },
      starter: {
        plan: "starter",
        displayName: "Starter",
        billingModel: "flat",
        isSelfServe: true,
        prices: { monthly: 6100, annual: 58800 },
        features: {
          evals: true,
          chatboxes: true,
          cicd: true,
          customDomains: false,
          auditLog: false,
          sso: false,
          prioritySupport: false,
        },
        limits: {
          maxMembers: 3,
          maxWorkspaces: 2,
          maxServersPerWorkspace: 10,
          maxChatboxesPerWorkspace: 1,
          maxEvalRunsPerMonth: 500,
        },
        includedSeats: 3,
        seatMinimum: null,
        checkout: {
          plan: "starter",
          supportedIntervals: ["monthly", "annual"],
        },
      },
      team: {
        plan: "team",
        displayName: "Team",
        billingModel: "per_seat",
        isSelfServe: true,
        prices: { monthly: 7400, annual: 70800 },
        features: {
          evals: true,
          chatboxes: true,
          cicd: true,
          customDomains: true,
          auditLog: false,
          sso: true,
          prioritySupport: true,
        },
        limits: {
          maxMembers: 100,
          maxWorkspaces: 10,
          maxServersPerWorkspace: null,
          maxChatboxesPerWorkspace: 3,
          maxEvalRunsPerMonth: 5000,
        },
        includedSeats: null,
        seatMinimum: 4,
        checkout: {
          plan: "team",
          supportedIntervals: ["monthly", "annual"],
        },
      },
      enterprise: {
        plan: "enterprise",
        displayName: "Enterprise",
        billingModel: "contact",
        isSelfServe: false,
        prices: { monthly: null, annual: null },
        features: {
          evals: true,
          chatboxes: true,
          cicd: true,
          customDomains: true,
          auditLog: true,
          sso: true,
          prioritySupport: true,
        },
        limits: {
          maxMembers: null,
          maxWorkspaces: null,
          maxServersPerWorkspace: null,
          maxChatboxesPerWorkspace: null,
          maxEvalRunsPerMonth: null,
        },
        includedSeats: null,
        seatMinimum: null,
        checkout: null,
      },
    },
  };
}

function billingStatusFixture(
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    organizationId: "org-1",
    organizationName: "Org One",
    plan: "free",
    effectivePlan: "free",
    source: "free",
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

function createBillingHookState(overrides: Record<string, unknown>) {
  return {
    billingStatus: undefined,
    entitlements: undefined,
    organizationPremiumness: undefined,
    workspacePremiumness: undefined,
    planCatalog: createPlanCatalog(),
    isLoadingBilling: false,
    isLoadingEntitlements: false,
    isLoadingOrganizationPremiumness: false,
    isLoadingWorkspacePremiumness: false,
    isLoadingPlanCatalog: false,
    isStartingPlanChange: false,
    pendingPlanChangeTarget: null,
    isOpeningPortal: false,
    isCancelingScheduledBillingChange: false,
    isSelectingFreeAfterTrial: false,
    error: null,
    startPlanChange: vi.fn(),
    openPortal: vi.fn(),
    openCancellationPortal: vi.fn(),
    openIntervalChangePortal: vi.fn(),
    cancelScheduledBillingChange: vi.fn(),
    selectFreeAfterTrial: vi.fn(),
    ...overrides,
  };
}

function renderAutoCheckoutTab(options?: {
  checkoutIntent?: CheckoutIntentWithOrganization;
  onCheckoutIntentConsumed?: () => void;
  onCheckoutIntentNavigationStarted?: () => void;
  navigateBillingInSameTab?: (url: string) => void;
}) {
  const initialCheckoutIntent: CheckoutIntentWithOrganization =
    options?.checkoutIntent ?? {
      organizationId: "org-1",
      plan: "starter",
      interval: "annual",
    };

  function Harness() {
    const [checkoutIntent, setCheckoutIntent] =
      useState<CheckoutIntentWithOrganization | null>(initialCheckoutIntent);

    return (
      <OrganizationsTab
        organizationId="org-1"
        section="billing"
        checkoutIntent={checkoutIntent}
        onCheckoutIntentConsumed={() => {
          options?.onCheckoutIntentConsumed?.();
          setCheckoutIntent(null);
        }}
        onCheckoutIntentNavigationStarted={
          options?.onCheckoutIntentNavigationStarted
        }
        navigateBillingInSameTab={options?.navigateBillingInSameTab}
      />
    );
  }

  return render(<Harness />);
}

function getPlanColumn(planName: string): HTMLElement {
  const heading = screen
    .getAllByText(planName)
    .find((element) => element.closest("th"));
  if (!heading) {
    throw new Error(`Could not find plan column for ${planName}`);
  }
  const column = heading.closest("th");
  if (!column) {
    throw new Error(`Could not resolve plan column container for ${planName}`);
  }
  return column;
}

vi.mock("@workos-inc/authkit-react", () => ({
  useAuth: (...args: unknown[]) => mockUseAuth(...args),
}));

vi.mock("convex/react", () => ({
  useConvexAuth: (...args: unknown[]) => mockUseConvexAuth(...args),
}));

vi.mock("posthog-js/react", () => ({
  useFeatureFlagEnabled: (...args: unknown[]) =>
    mockUseFeatureFlagEnabled(...args),
}));

vi.mock("sonner", () => ({
  toast: {
    success: vi.fn(),
    error: vi.fn(),
    warning: vi.fn(),
  },
}));

vi.mock("@/hooks/useOrganizations", () => ({
  useOrganizationQueries: (...args: unknown[]) =>
    mockUseOrganizationQueries(...args),
  useOrganizationMembers: (...args: unknown[]) =>
    mockUseOrganizationMembers(...args),
  useOrganizationMutations: () => ({
    updateOrganization: updateOrganizationMock,
    deleteOrganization: deleteOrganizationMock,
    addMember: addMemberMock,
    changeMemberRole: changeMemberRoleMock,
    transferOrganizationOwnership: transferOrganizationOwnershipMock,
    removeMember: removeMemberMock,
    generateLogoUploadUrl: generateLogoUploadUrlMock,
    updateOrganizationLogo: updateOrganizationLogoMock,
  }),
  resolveOrganizationRole: (member: { role?: string; isOwner?: boolean }) => {
    if (member.role) return member.role;
    return member.isOwner ? "owner" : "member";
  },
}));

vi.mock("@/hooks/useOrganizationBilling", () => ({
  useOrganizationBilling: vi.fn(),
  isPaidPlan: (plan: string) => plan !== "free",
}));

vi.mock("../organization/OrganizationAuditLog", () => ({
  OrganizationAuditLog: () => <div data-testid="organization-audit-log" />,
}));

vi.mock("../organization/OrganizationMemberRow", () => ({
  OrganizationMemberRow: () => <div data-testid="organization-member-row" />,
}));

describe("OrganizationsTab billing", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    addMemberMock.mockResolvedValue({ isPending: false });
    removeMemberMock.mockResolvedValue(undefined);

    mockUseConvexAuth.mockReturnValue({ isAuthenticated: true });
    mockUseFeatureFlagEnabled.mockImplementation((flag: string) => {
      if (flag === "billing-entitlements-ui") return true;
      return true;
    });
    mockUseAuth.mockReturnValue({
      user: { email: "owner@example.com" },
      signIn: vi.fn(),
    });

    mockUseOrganizationQueries.mockReturnValue({
      sortedOrganizations: [
        {
          _id: "org-1",
          name: "Org One",
          createdBy: "user_1",
          createdAt: 1,
          updatedAt: 1,
          myRole: "owner",
        },
      ],
      isLoading: false,
    });

    mockUseOrganizationMembers.mockReturnValue({
      activeMembers: [
        {
          _id: "member-owner",
          organizationId: "org-1",
          userId: "user-owner",
          email: "owner@example.com",
          role: "owner",
          isOwner: true,
          addedBy: "user-owner",
          addedAt: 1,
          user: { name: "Owner", email: "owner@example.com", imageUrl: "" },
        },
      ],
      pendingMembers: [],
      isLoading: false,
    });
  });

  it("shows a View plans entry point in the overview billing card", () => {
    mockUseOrganizationBilling.mockReturnValue(
      createBillingHookState({
        billingStatus: billingStatusFixture({ plan: "free" }),
      }),
    );

    render(<OrganizationsTab organizationId="org-1" />);

    expect(screen.getByRole("button", { name: "Billing" })).toBeInTheDocument();
    expect(screen.getByText("Billing cycle")).toBeInTheDocument();
    expect(screen.queryByText("Subscription status")).not.toBeInTheDocument();
    expect(screen.getByTestId("current-plan-renewal")).toHaveTextContent(
      "No active subscription",
    );
    expect(
      screen.getByRole("button", { name: "View plans" }),
    ).toBeInTheDocument();
  });

  it("overview billing card hides Manage plan for non-owners and shows owner-only copy beside View plans", () => {
    mockUseOrganizationBilling.mockReturnValue(
      createBillingHookState({
        billingStatus: billingStatusFixture({
          plan: "team",
          effectivePlan: "team",
          billingInterval: "monthly",
          subscriptionStatus: "active",
          hasCustomer: true,
          stripeCurrentPeriodEnd: 1_705_000_000_000,
          stripePriceId: "price_team",
          canManageBilling: false,
          isOwner: false,
        }),
      }),
    );

    render(<OrganizationsTab organizationId="org-1" />);

    expect(screen.queryByRole("button", { name: "Manage plan" })).toBeNull();
    const viewPlans = screen.getByRole("button", { name: "View plans" });
    const ownerCopy = screen.getByText(
      "Only organization owners can manage billing.",
    );
    expect(ownerCopy).toBeInTheDocument();
    expect(viewPlans.parentElement).toContainElement(ownerCopy);
  });

  it("shows scheduled cancellation state instead of renewal copy for non-renewing subscriptions", () => {
    mockUseOrganizationBilling.mockReturnValue(
      createBillingHookState({
        billingStatus: billingStatusFixture({
          plan: "team",
          effectivePlan: "team",
          billingInterval: "monthly",
          subscriptionStatus: "active",
          hasCustomer: true,
          stripeCancelAtPeriodEnd: true,
          stripeCancelAt: Date.parse("2026-05-01T12:00:00.000Z"),
          stripeCanceledAt: Date.parse("2026-03-31T12:00:00.000Z"),
          stripeCurrentPeriodEnd: Date.parse("2026-05-01T12:00:00.000Z"),
          stripePriceId: "price_team",
        }),
      }),
    );

    render(<OrganizationsTab organizationId="org-1" />);

    expect(screen.getByTestId("current-plan-renewal")).toHaveTextContent(
      "Cancels May 1, 2026",
    );
    expect(
      screen.getByTestId("current-plan-non-renewing-badge"),
    ).toHaveTextContent("Will not renew");
    expect(
      screen.getByTestId("current-plan-scheduled-cancel"),
    ).toHaveTextContent("Service ends May 1, 2026. Will not renew.");
    expect(screen.queryByText(/Renews /)).not.toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "Change to annual" }),
    ).not.toBeInTheDocument();
  });

  it("does not show stale billing-updating copy once plan and interval are resolved", () => {
    mockUseOrganizationBilling.mockReturnValue(
      createBillingHookState({
        billingStatus: billingStatusFixture({
          plan: "team",
          effectivePlan: "team",
          billingInterval: "annual",
          subscriptionStatus: "active",
          hasCustomer: true,
          stripeCurrentPeriodEnd: Date.parse("2027-03-31T00:00:00.000Z"),
          stripePriceId: "price_team_annual",
        }),
      }),
    );

    render(<OrganizationsTab organizationId="org-1" />);

    expect(
      screen.getByText("$59 per seat/month, billed annually · 4 seat minimum"),
    ).toBeInTheDocument();
    expect(
      screen.queryByText("Billing details are updating…"),
    ).not.toBeInTheDocument();
  });

  it("shows a scheduled interval change and offers a same-tier reversal CTA", () => {
    mockUseOrganizationBilling.mockReturnValue(
      createBillingHookState({
        billingStatus: billingStatusFixture({
          plan: "starter",
          effectivePlan: "starter",
          billingInterval: "annual",
          subscriptionStatus: "active",
          hasCustomer: true,
          stripeCurrentPeriodEnd: Date.parse("2027-03-31T12:00:00.000Z"),
          stripePriceId: "price_starter_annual",
          stripeScheduledPlan: "starter",
          stripeScheduledBillingInterval: "monthly",
          stripeScheduledPriceId: "price_starter_monthly",
          stripeScheduledEffectiveAt: Date.parse("2027-04-01T12:00:00.000Z"),
          canCancelScheduledBillingChange: true,
        }),
      }),
    );

    render(<OrganizationsTab organizationId="org-1" />);

    expect(screen.getByTestId("current-plan-renewal")).toHaveTextContent(
      "Changes Apr 1, 2027",
    );
    expect(
      screen.getByTestId("current-plan-scheduled-change"),
    ).toHaveTextContent("Monthly billing starts Apr 1, 2027.");
    expect(
      screen.queryByRole("button", { name: "Change to monthly" }),
    ).not.toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "Keep Starter annual plan" }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "Manage plan" }),
    ).toBeInTheDocument();
  });

  it("confirms and cancels a scheduled same-tier cadence change from the current plan card", async () => {
    const cancelScheduledBillingChange = vi.fn();
    const hookState = createBillingHookState({
      billingStatus: billingStatusFixture({
        plan: "team",
        effectivePlan: "team",
        billingInterval: "annual",
        subscriptionStatus: "active",
        hasCustomer: true,
        stripeCurrentPeriodEnd: Date.parse("2027-03-31T12:00:00.000Z"),
        stripePriceId: "price_team_annual",
        stripeScheduledPlan: "team",
        stripeScheduledBillingInterval: "monthly",
        stripeScheduledPriceId: "price_team_monthly",
        stripeScheduledEffectiveAt: Date.parse("2027-04-01T12:00:00.000Z"),
        canCancelScheduledBillingChange: true,
      }),
      cancelScheduledBillingChange:
        cancelScheduledBillingChange.mockImplementation(async () => {
          hookState.billingStatus = billingStatusFixture({
            plan: "team",
            effectivePlan: "team",
            billingInterval: "annual",
            subscriptionStatus: "active",
            hasCustomer: true,
            stripeCurrentPeriodEnd: Date.parse("2027-03-31T12:00:00.000Z"),
            stripePriceId: "price_team_annual",
          });
          return {
            plan: "team",
            billingInterval: "annual",
          };
        }),
    });
    mockUseOrganizationBilling.mockImplementation(() => hookState);

    const view = render(<OrganizationsTab organizationId="org-1" />);

    fireEvent.click(
      screen.getByRole("button", { name: "Keep Team annual plan" }),
    );

    expect(
      screen.getByRole("heading", { name: "Keep Team annual plan?" }),
    ).toBeInTheDocument();
    expect(
      screen.getByText(
        "This cancels the pending switch to monthly billing on Apr 1, 2027. Team annual remains active.",
      ),
    ).toBeInTheDocument();

    fireEvent.click(
      within(screen.getByRole("alertdialog")).getByRole("button", {
        name: "Keep Team annual plan",
      }),
    );

    await waitFor(() => {
      expect(cancelScheduledBillingChange).toHaveBeenCalledTimes(1);
    });
    expect(toast.success).toHaveBeenCalledWith(
      "Scheduled billing change canceled. Team annual remains active.",
    );

    view.rerender(<OrganizationsTab organizationId="org-1" />);

    expect(
      screen.queryByTestId("current-plan-scheduled-change"),
    ).not.toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "Change to monthly" }),
    ).toBeInTheDocument();
  });

  it("shows explicit cross-tier scheduled copy and a reversal CTA when the change is cancelable", async () => {
    const cancelScheduledBillingChange = vi.fn();
    const hookState = createBillingHookState({
      billingStatus: billingStatusFixture({
        plan: "team",
        effectivePlan: "team",
        billingInterval: "annual",
        subscriptionStatus: "active",
        hasCustomer: true,
        stripeCurrentPeriodEnd: Date.parse("2027-03-31T12:00:00.000Z"),
        stripePriceId: "price_team_annual",
        stripeScheduledPlan: "starter",
        stripeScheduledBillingInterval: "monthly",
        stripeScheduledPriceId: "price_starter_monthly",
        stripeScheduledEffectiveAt: Date.parse("2027-04-01T12:00:00.000Z"),
        canCancelScheduledBillingChange: true,
      }),
      cancelScheduledBillingChange:
        cancelScheduledBillingChange.mockResolvedValue({
          plan: "team",
          billingInterval: "annual",
        }),
    });
    mockUseOrganizationBilling.mockImplementation(() => hookState);

    render(<OrganizationsTab organizationId="org-1" />);

    expect(
      screen.getByTestId("current-plan-scheduled-change"),
    ).toHaveTextContent(
      "Starter monthly starts Apr 1, 2027. Team annual remains active until then.",
    );
    expect(
      screen.getByRole("button", { name: "Keep Team annual plan" }),
    ).toBeInTheDocument();
    fireEvent.click(
      screen.getByRole("button", { name: "Keep Team annual plan" }),
    );

    await waitFor(() => {
      expect(
        screen.getByText(
          "This cancels the pending change to Starter monthly on Apr 1, 2027. Team annual remains active.",
        ),
      ).toBeInTheDocument();
    });
  });

  it("does not offer an inline reversal CTA for cross-tier scheduled changes when cancellation is unavailable", () => {
    mockUseOrganizationBilling.mockReturnValue(
      createBillingHookState({
        billingStatus: billingStatusFixture({
          plan: "team",
          effectivePlan: "team",
          billingInterval: "annual",
          subscriptionStatus: "active",
          hasCustomer: true,
          stripeCurrentPeriodEnd: Date.parse("2027-03-31T12:00:00.000Z"),
          stripePriceId: "price_team_annual",
          stripeScheduledPlan: "starter",
          stripeScheduledBillingInterval: "monthly",
          stripeScheduledPriceId: "price_starter_monthly",
          stripeScheduledEffectiveAt: Date.parse("2027-04-01T12:00:00.000Z"),
        }),
      }),
    );

    render(<OrganizationsTab organizationId="org-1" />);

    expect(
      screen.getByTestId("current-plan-scheduled-change"),
    ).toHaveTextContent(
      "Starter monthly starts Apr 1, 2027. Team annual remains active until then.",
    );
    expect(
      screen.queryByRole("button", { name: "Keep Team annual plan" }),
    ).not.toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "Manage plan" }),
    ).toBeInTheDocument();
  });

  it("shows trial messaging without paid Starter pricing copy for active trials", () => {
    mockUseOrganizationBilling.mockReturnValue(
      createBillingHookState({
        billingStatus: billingStatusFixture({
          plan: "free",
          effectivePlan: "starter",
          source: "trial",
          trialStatus: "active",
          trialPlan: "starter",
          trialEndsAt: Date.parse("2026-04-08T00:00:00.000Z"),
        }),
      }),
    );

    render(<OrganizationsTab organizationId="org-1" />);

    expect(screen.getByText("Starter Trial")).toBeInTheDocument();
    expect(
      screen.getByText("7-day trial · no active subscription yet"),
    ).toBeInTheDocument();
    expect(screen.getByTestId("current-plan-renewal")).toHaveTextContent(
      "Trial ends",
    );
    expect(
      screen.queryByText(/flat monthly rate|per seat\/month/i),
    ).not.toBeInTheDocument();
  });

  it("shows simulated effective plans with an explicit simulation banner", () => {
    mockUseOrganizationBilling.mockReturnValue(
      createBillingHookState({
        billingStatus: billingStatusFixture({
          plan: "free",
          effectivePlan: "starter",
          source: "simulation",
        }),
      }),
    );

    render(<OrganizationsTab organizationId="org-1" />);

    expect(screen.getByText("Starter")).toBeInTheDocument();
    expect(
      screen.getByText(
        "Simulation active. Limits and access use Starter, while billing remains on Free.",
      ),
    ).toBeInTheDocument();
    expect(
      screen.getByText("Simulation active · billing changes are not applied"),
    ).toBeInTheDocument();
  });

  it("hides the overview billing card when the billing UI flag is off", () => {
    mockUseFeatureFlagEnabled.mockReturnValue(false);
    mockUseOrganizationBilling.mockReturnValue(
      createBillingHookState({
        billingStatus: billingStatusFixture({
          plan: "starter",
          effectivePlan: "starter",
          billingInterval: "monthly",
          subscriptionStatus: "active",
          hasCustomer: true,
          stripeCurrentPeriodEnd: 1_705_000_000_000,
          stripePriceId: "price_123",
        }),
      }),
    );

    render(<OrganizationsTab organizationId="org-1" />);

    expect(
      screen.queryByRole("button", { name: "Plans & billing" }),
    ).not.toBeInTheDocument();
    expect(screen.queryByText("Billing account")).not.toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "View plans" }),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "Manage plan" }),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "Upgrade plan" }),
    ).not.toBeInTheDocument();
  });

  it("shows the billing subview summary and plan cards", () => {
    mockUseOrganizationBilling.mockReturnValue(
      createBillingHookState({
        billingStatus: billingStatusFixture({
          plan: "starter",
          effectivePlan: "starter",
          billingInterval: "monthly",
          subscriptionStatus: "active",
          hasCustomer: true,
          stripeCurrentPeriodEnd: 1_705_000_000_000,
          stripePriceId: "price_123",
        }),
      }),
    );

    render(<OrganizationsTab organizationId="org-1" section="billing" />);

    expect(screen.getByText("Plans & Billing")).toBeInTheDocument();
    expect(screen.getAllByText("Current plan").length).toBeGreaterThan(0);
    expect(screen.getAllByText("Starter").length).toBeGreaterThan(0);
    expect(screen.getAllByText("Team").length).toBeGreaterThan(0);
    expect(screen.getAllByText("Enterprise").length).toBeGreaterThan(0);
  });

  it("disables billing actions for admins while keeping the page visible", () => {
    mockUseOrganizationMembers.mockReturnValue({
      activeMembers: [
        {
          _id: "member-user",
          organizationId: "org-1",
          userId: "user-admin",
          email: "admin@example.com",
          role: "admin",
          isOwner: false,
          addedBy: "user-owner",
          addedAt: 1,
          user: {
            name: "Admin",
            email: "admin@example.com",
            imageUrl: "",
          },
        },
      ],
      pendingMembers: [],
      isLoading: false,
    });
    mockUseAuth.mockReturnValue({
      user: { email: "admin@example.com" },
      signIn: vi.fn(),
    });
    mockUseOrganizationQueries.mockReturnValue({
      sortedOrganizations: [
        {
          _id: "org-1",
          name: "Org One",
          createdBy: "user_1",
          createdAt: 1,
          updatedAt: 1,
          myRole: "admin",
        },
      ],
      isLoading: false,
    });

    mockUseOrganizationBilling.mockReturnValue(
      createBillingHookState({
        billingStatus: billingStatusFixture({
          canManageBilling: false,
          isOwner: false,
        }),
      }),
    );

    render(<OrganizationsTab organizationId="org-1" section="billing" />);

    expect(
      screen.getByText(
        "Only organization owners can manage billing changes. Admins can review plan details here.",
      ),
    ).toBeInTheDocument();
    for (const button of screen.getAllByRole("button", {
      name: "Upgrade",
    })) {
      expect(button).toBeDisabled();
    }
    expect(screen.getByRole("button", { name: "Talk to sales" })).toBeEnabled();
  });

  it("shows non-owner billing copy when an admin invite hits the member limit", async () => {
    mockUseOrganizationMembers.mockReturnValue({
      activeMembers: [
        {
          _id: "member-user",
          organizationId: "org-1",
          userId: "user-admin",
          email: "admin@example.com",
          role: "admin",
          isOwner: false,
          addedBy: "user-owner",
          addedAt: 1,
          user: {
            name: "Admin",
            email: "admin@example.com",
            imageUrl: "",
          },
        },
      ],
      pendingMembers: [],
      isLoading: false,
    });
    mockUseAuth.mockReturnValue({
      user: { email: "admin@example.com" },
      signIn: vi.fn(),
    });
    mockUseOrganizationQueries.mockReturnValue({
      sortedOrganizations: [
        {
          _id: "org-1",
          name: "Org One",
          createdBy: "user_1",
          createdAt: 1,
          updatedAt: 1,
          myRole: "admin",
        },
      ],
      isLoading: false,
    });
    mockUseOrganizationBilling.mockReturnValue(
      createBillingHookState({
        billingStatus: billingStatusFixture({
          canManageBilling: false,
          isOwner: false,
        }),
      }),
    );
    addMemberMock.mockRejectedValue(
      new Error(
        JSON.stringify({
          code: "billing_limit_reached",
          limit: "maxMembers",
          allowedValue: 3,
        }),
      ),
    );

    render(<OrganizationsTab organizationId="org-1" />);

    fireEvent.change(screen.getByPlaceholderText("Email address"), {
      target: { value: "new-user@example.com" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Add member" }));

    await waitFor(() => {
      expect(addMemberMock).toHaveBeenCalledWith({
        organizationId: "org-1",
        email: "new-user@example.com",
      });
    });
    expect(toast.error).toHaveBeenCalledWith(
      "This organization has reached its member limit (3). Ask an organization owner to upgrade.",
    );
  });

  it("shows an inline upgrade upsell when member invites are denied by billing", () => {
    mockUseOrganizationBilling.mockReturnValue(
      createBillingHookState({
        billingStatus: billingStatusFixture({
          plan: "free",
          effectivePlan: "free",
          canManageBilling: true,
        }),
        organizationPremiumness: {
          plan: "free",
          enforcementState: "active",
          effectivePlan: "free",
          billingInterval: null,
          source: "free",
          decisionRequired: false,
          gates: [
            {
              gateKey: "maxMembers",
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
      }),
    );

    render(<OrganizationsTab organizationId="org-1" />);

    fireEvent.change(screen.getByPlaceholderText("Email address"), {
      target: { value: "new-user@example.com" },
    });

    expect(screen.getByTestId("member-limit-upsell")).toBeInTheDocument();
    expect(
      screen.getByText(
        "This organization has reached its member limit (1). Upgrade to add more members.",
      ),
    ).toBeInTheDocument();
    expect(
      screen.getByText(
        "Starter includes up to 3 members and 2 workspaces for $61/mo flat.",
      ),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "Upgrade to Starter" }),
    ).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Add member" })).toBeDisabled();
  });

  it("shows inline owner-directed copy when member invites are denied for non-owners", () => {
    mockUseOrganizationMembers.mockReturnValue({
      activeMembers: [
        {
          _id: "member-user",
          organizationId: "org-1",
          userId: "user-admin",
          email: "admin@example.com",
          role: "admin",
          isOwner: false,
          addedBy: "user-owner",
          addedAt: 1,
          user: {
            name: "Admin",
            email: "admin@example.com",
            imageUrl: "",
          },
        },
      ],
      pendingMembers: [],
      isLoading: false,
    });
    mockUseAuth.mockReturnValue({
      user: { email: "admin@example.com" },
      signIn: vi.fn(),
    });
    mockUseOrganizationQueries.mockReturnValue({
      sortedOrganizations: [
        {
          _id: "org-1",
          name: "Org One",
          createdBy: "user_1",
          createdAt: 1,
          updatedAt: 1,
          myRole: "admin",
        },
      ],
      isLoading: false,
    });
    mockUseOrganizationBilling.mockReturnValue(
      createBillingHookState({
        billingStatus: billingStatusFixture({
          plan: "free",
          effectivePlan: "free",
          canManageBilling: false,
          isOwner: false,
        }),
        organizationPremiumness: {
          plan: "free",
          enforcementState: "active",
          effectivePlan: "free",
          billingInterval: null,
          source: "free",
          decisionRequired: false,
          gates: [
            {
              gateKey: "maxMembers",
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
      }),
    );

    render(<OrganizationsTab organizationId="org-1" />);

    expect(screen.getByTestId("member-limit-upsell")).toBeInTheDocument();
    expect(
      screen.getByText("Ask an organization owner to review billing options."),
    ).toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "Upgrade to Starter" }),
    ).not.toBeInTheDocument();
  });

  it("shows Team as a purchasable upgrade when billing UI is enabled", () => {
    mockUseOrganizationBilling.mockReturnValue(
      createBillingHookState({
        billingStatus: billingStatusFixture({
          plan: "starter",
          effectivePlan: "starter",
          billingInterval: "monthly",
          subscriptionStatus: "active",
          hasCustomer: true,
          stripePriceId: "price_123",
        }),
      }),
    );

    render(<OrganizationsTab organizationId="org-1" section="billing" />);

    expect(screen.queryByText("Coming soon")).not.toBeInTheDocument();
    expect(screen.getAllByRole("button", { name: "Upgrade" })).toHaveLength(1);
  });

  it("updates pricing when the billing interval toggle changes", () => {
    mockUseOrganizationBilling.mockReturnValue(
      createBillingHookState({
        billingStatus: billingStatusFixture(),
      }),
    );

    render(<OrganizationsTab organizationId="org-1" section="billing" />);

    // Default interval is monthly — Starter lists $61/mo
    expect(screen.getByText(/\$61/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: /Annual/ }));
    expect(screen.getByText(/\$49/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: /^Monthly$/ }));
    expect(screen.getByText(/\$61/)).toBeInTheDocument();
  });

  it("starts checkout for Starter from the billing subview", async () => {
    const startPlanChange = vi.fn().mockResolvedValue({
      kind: "checkout",
      checkoutUrl: "https://stripe.test/checkout",
    });
    mockUseOrganizationBilling.mockReturnValue(
      createBillingHookState({
        billingStatus: billingStatusFixture(),
        startPlanChange,
      }),
    );

    const openSpy = vi.spyOn(window, "open").mockImplementation(() => null);

    render(<OrganizationsTab organizationId="org-1" section="billing" />);

    const upgradeButtons = screen.getAllByRole("button", { name: "Upgrade" });
    fireEvent.click(upgradeButtons[0]!);

    await waitFor(() => {
      expect(startPlanChange).toHaveBeenCalledWith(
        expect.stringContaining("#organizations/org-1/billing"),
        "starter",
        "monthly",
        { confirmPaidPlanChange: true },
      );
    });
    expect(screen.queryByText("Upgrade to Team?")).not.toBeInTheDocument();
    expect(openSpy).toHaveBeenCalledWith(
      "https://stripe.test/checkout",
      "_blank",
      "noopener,noreferrer",
    );
    openSpy.mockRestore();
  });

  it("disables self-serve compare-table actions while a plan change is in flight", () => {
    mockUseOrganizationBilling.mockReturnValue(
      createBillingHookState({
        billingStatus: billingStatusFixture(),
        isStartingPlanChange: true,
        pendingPlanChangeTarget: "team",
      }),
    );

    render(<OrganizationsTab organizationId="org-1" section="billing" />);

    expect(
      within(getPlanColumn("Starter")).getByRole("button", {
        name: "Upgrade",
      }),
    ).toBeDisabled();
    expect(
      within(getPlanColumn("Team")).getByRole("button", {
        name: "Loading...",
      }),
    ).toBeDisabled();
  });

  it("opens a confirmation dialog before paid upgrades", async () => {
    const startPlanChange = vi.fn();
    mockUseOrganizationBilling.mockReturnValue(
      createBillingHookState({
        billingStatus: billingStatusFixture({
          plan: "starter",
          effectivePlan: "starter",
          billingInterval: "monthly",
          subscriptionStatus: "active",
          hasCustomer: true,
          stripePriceId: "price_starter",
        }),
        startPlanChange,
      }),
    );

    render(<OrganizationsTab organizationId="org-1" section="billing" />);

    fireEvent.click(screen.getByRole("button", { name: "Upgrade" }));

    expect(screen.getByText("Upgrade to Team?")).toBeInTheDocument();
    expect(
      screen.getByText(
        "This upgrade takes effect immediately and updates your existing Starter subscription in place.",
      ),
    ).toBeInTheDocument();
    expect(
      screen.getByText("We do not send you through Stripe Checkout."),
    ).toBeInTheDocument();
    expect(
      screen.getByText(
        "Stripe prorates the rest of your current billing period instead of waiting until renewal, so unused Starter time is factored into the Team change.",
      ),
    ).toBeInTheDocument();
    expect(
      screen.getByText(/Team at \$296\/month \(4-seat minimum\)/),
    ).toBeInTheDocument();
    expect(startPlanChange).not.toHaveBeenCalled();
  });

  it("does not change plan when the paid upgrade confirmation is canceled", async () => {
    const startPlanChange = vi.fn();
    mockUseOrganizationBilling.mockReturnValue(
      createBillingHookState({
        billingStatus: billingStatusFixture({
          plan: "starter",
          effectivePlan: "starter",
          billingInterval: "monthly",
          subscriptionStatus: "active",
          hasCustomer: true,
          stripePriceId: "price_starter",
        }),
        startPlanChange,
      }),
    );

    render(<OrganizationsTab organizationId="org-1" section="billing" />);

    fireEvent.click(screen.getByRole("button", { name: "Upgrade" }));
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));

    await waitFor(() => {
      expect(screen.queryByText("Upgrade to Team?")).not.toBeInTheDocument();
    });
    expect(startPlanChange).not.toHaveBeenCalled();
  });

  it("disables the paid-upgrade confirmation buttons while the upgrade request is running", async () => {
    const hookState = createBillingHookState({
      billingStatus: billingStatusFixture({
        plan: "starter",
        effectivePlan: "starter",
        billingInterval: "monthly",
        subscriptionStatus: "active",
        hasCustomer: true,
        stripePriceId: "price_starter",
      }),
      isStartingPlanChange: false,
    });
    mockUseOrganizationBilling.mockImplementation(() => hookState);

    const view = render(
      <OrganizationsTab organizationId="org-1" section="billing" />,
    );

    fireEvent.click(screen.getByRole("button", { name: "Upgrade" }));
    expect(screen.getByText("Upgrade to Team?")).toBeInTheDocument();

    hookState.isStartingPlanChange = true;
    hookState.pendingPlanChangeTarget = "team";
    view.rerender(
      <OrganizationsTab organizationId="org-1" section="billing" />,
    );

    expect(screen.getByRole("button", { name: "Upgrading..." })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Cancel" })).toBeDisabled();
  });

  it("updates the existing subscription in place after paid upgrade confirmation", async () => {
    const startPlanChange = vi.fn().mockResolvedValue({
      kind: "updated",
      subscription: {
        plan: "team",
        billingInterval: "monthly",
      },
    });
    mockUseOrganizationBilling.mockReturnValue(
      createBillingHookState({
        billingStatus: billingStatusFixture({
          plan: "starter",
          effectivePlan: "starter",
          billingInterval: "monthly",
          subscriptionStatus: "active",
          hasCustomer: true,
          stripePriceId: "price_starter",
        }),
        startPlanChange,
      }),
    );

    const openSpy = vi.spyOn(window, "open").mockImplementation(() => null);

    render(<OrganizationsTab organizationId="org-1" section="billing" />);

    fireEvent.click(screen.getByRole("button", { name: "Upgrade" }));
    expect(screen.getByText("Upgrade to Team?")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Upgrade now" }));

    await waitFor(() => {
      expect(startPlanChange).toHaveBeenCalledWith(
        expect.stringContaining("#organizations/org-1/billing"),
        "team",
        "monthly",
        { confirmPaidPlanChange: true },
      );
    });
    expect(openSpy).not.toHaveBeenCalled();
    expect(toast.success).toHaveBeenCalledWith("Plan updated to Team.");
    await waitFor(() => {
      expect(screen.queryByText("Upgrade to Team?")).not.toBeInTheDocument();
    });

    openSpy.mockRestore();
  });

  it("confirms team downgrades to Starter, schedules them for renewal, and stays in app", async () => {
    const hookState = createBillingHookState({
      billingStatus: billingStatusFixture({
        plan: "team",
        effectivePlan: "team",
        billingInterval: "annual",
        subscriptionStatus: "active",
        hasCustomer: true,
        stripeCurrentPeriodEnd: Date.parse("2027-04-01T12:00:00.000Z"),
        stripePriceId: "price_team_annual",
      }),
    });
    const startPlanChange = vi.fn().mockImplementation(async () => {
      hookState.billingStatus = billingStatusFixture({
        plan: "team",
        effectivePlan: "team",
        billingInterval: "annual",
        subscriptionStatus: "active",
        hasCustomer: true,
        stripeCurrentPeriodEnd: Date.parse("2027-04-01T12:00:00.000Z"),
        stripePriceId: "price_team_annual",
        stripeScheduledPlan: "starter",
        stripeScheduledBillingInterval: "monthly",
        stripeScheduledPriceId: "price_starter_monthly",
        stripeScheduledEffectiveAt: Date.parse("2027-04-01T12:00:00.000Z"),
        canCancelScheduledBillingChange: true,
      });
      return {
        kind: "scheduled",
        subscription: {
          plan: "team",
          billingInterval: "annual",
          stripeScheduledPlan: "starter",
          stripeScheduledBillingInterval: "monthly",
          stripeCanCancelScheduledBillingChange: true,
        },
      };
    });
    hookState.startPlanChange = startPlanChange;
    mockUseOrganizationBilling.mockImplementation(() => hookState);

    const openSpy = vi.spyOn(window, "open").mockImplementation(() => null);
    const view = render(
      <OrganizationsTab organizationId="org-1" section="billing" />,
    );

    fireEvent.click(screen.getByRole("button", { name: /^Monthly$/ }));
    fireEvent.click(
      within(getPlanColumn("Starter")).getByRole("button", {
        name: "Downgrade",
      }),
    );

    expect(screen.getByText("Downgrade to Starter?")).toBeInTheDocument();
    expect(
      screen.getByText("This downgrade takes effect at renewal, not now."),
    ).toBeInTheDocument();
    expect(
      screen.getByText("Team annual remains active until then."),
    ).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Schedule downgrade" }));

    await waitFor(() => {
      expect(startPlanChange).toHaveBeenCalledWith(
        expect.stringContaining("#organizations/org-1/billing"),
        "starter",
        "monthly",
        { confirmPaidPlanChange: false },
      );
    });
    expect(openSpy).not.toHaveBeenCalled();
    expect(toast.success).toHaveBeenCalledWith(
      "Downgrade to Starter monthly scheduled for renewal.",
    );

    view.rerender(<OrganizationsTab organizationId="org-1" />);

    expect(
      screen.getByTestId("current-plan-scheduled-change"),
    ).toHaveTextContent(
      "Starter monthly starts Apr 1, 2027. Team annual remains active until then.",
    );
    expect(
      screen.getByRole("button", { name: "Keep Team annual plan" }),
    ).toBeInTheDocument();

    openSpy.mockRestore();
  });

  it("opens the dedicated cancellation flow when downgrading from a paid plan to Free", async () => {
    const startPlanChange = vi.fn();
    const openPortal = vi.fn().mockResolvedValue("https://stripe.test/portal");
    const openCancellationPortal = vi
      .fn()
      .mockResolvedValue("https://stripe.test/portal/cancel");
    mockUseOrganizationBilling.mockReturnValue(
      createBillingHookState({
        billingStatus: billingStatusFixture({
          plan: "starter",
          effectivePlan: "starter",
          billingInterval: "annual",
          subscriptionStatus: "active",
          hasCustomer: true,
          stripeCurrentPeriodEnd: Date.parse("2027-04-01T12:00:00.000Z"),
          stripePriceId: "price_starter_annual",
        }),
        startPlanChange,
        openPortal,
        openCancellationPortal,
      }),
    );

    const openSpy = vi.spyOn(window, "open").mockImplementation(() => null);

    render(<OrganizationsTab organizationId="org-1" section="billing" />);

    fireEvent.click(
      within(getPlanColumn("Free")).getByRole("button", {
        name: "Downgrade",
      }),
    );

    expect(screen.getByText("Return to Free at renewal?")).toBeInTheDocument();
    expect(
      screen.getByText("This cancellation takes effect at renewal, not now."),
    ).toBeInTheDocument();
    expect(
      screen.getByText("Starter annual remains active until Apr 1, 2027."),
    ).toBeInTheDocument();
    expect(
      screen.getByText("After that, the organization returns to Free."),
    ).toBeInTheDocument();
    expect(
      screen.getByText(
        "Stripe will open a cancellation flow that keeps paid access active until renewal.",
      ),
    ).toBeInTheDocument();

    fireEvent.click(
      screen.getByRole("button", { name: "Open cancellation flow" }),
    );

    await waitFor(() => {
      expect(openCancellationPortal).toHaveBeenCalledWith(
        expect.stringContaining("#organizations/org-1/billing"),
      );
    });
    expect(startPlanChange).not.toHaveBeenCalled();
    expect(openPortal).not.toHaveBeenCalled();
    expect(openSpy).toHaveBeenCalledWith(
      "https://stripe.test/portal/cancel",
      "_blank",
      "noopener,noreferrer",
    );

    openSpy.mockRestore();
  });

  it("auto-checks out billing deep links in the same tab", async () => {
    const startPlanChange = vi.fn().mockResolvedValue({
      kind: "checkout",
      checkoutUrl: "https://stripe.test/checkout",
    });
    mockUseOrganizationBilling.mockReturnValue(
      createBillingHookState({
        billingStatus: billingStatusFixture(),
        startPlanChange,
      }),
    );

    const openSpy = vi.spyOn(window, "open").mockImplementation(() => null);
    const navigateBillingInSameTab = vi.fn();
    const onCheckoutIntentConsumed = vi.fn();
    const onCheckoutIntentNavigationStarted = vi.fn();

    renderAutoCheckoutTab({
      onCheckoutIntentConsumed,
      onCheckoutIntentNavigationStarted,
      navigateBillingInSameTab,
    });

    expect(
      screen.getByTestId("billing-deep-link-redirect"),
    ).toBeInTheDocument();

    await waitFor(() => {
      expect(startPlanChange).toHaveBeenCalledWith(
        expect.stringContaining("#organizations/org-1/billing"),
        "starter",
        "annual",
        { confirmPaidPlanChange: false },
      );
    });
    expect(onCheckoutIntentNavigationStarted).toHaveBeenCalled();
    await waitFor(() => {
      expect(onCheckoutIntentConsumed).toHaveBeenCalled();
    });
    expect(navigateBillingInSameTab).toHaveBeenCalledWith(
      "https://stripe.test/checkout",
    );
    expect(openSpy).not.toHaveBeenCalled();
    await waitFor(() => {
      expect(
        screen.queryByTestId("billing-deep-link-redirect"),
      ).not.toBeInTheDocument();
    });

    openSpy.mockRestore();
  });

  it("starts auto-checkout only once for the same deep-link intent key", async () => {
    const startPlanChange = vi.fn().mockResolvedValue({
      kind: "checkout",
      checkoutUrl: "https://stripe.test/checkout",
    });
    const hookState = createBillingHookState({
      billingStatus: billingStatusFixture(),
      startPlanChange,
    });
    mockUseOrganizationBilling.mockImplementation(() => hookState);

    const navigateBillingInSameTab = vi.fn();
    const checkoutIntent = {
      organizationId: "org-1",
      plan: "starter" as const,
      interval: "annual" as const,
    };

    const view = render(
      <OrganizationsTab
        organizationId="org-1"
        section="billing"
        checkoutIntent={checkoutIntent}
        navigateBillingInSameTab={navigateBillingInSameTab}
      />,
    );

    await waitFor(() => {
      expect(startPlanChange).toHaveBeenCalledTimes(1);
    });

    view.rerender(
      <OrganizationsTab
        organizationId="org-1"
        section="billing"
        checkoutIntent={{ ...checkoutIntent }}
        navigateBillingInSameTab={navigateBillingInSameTab}
      />,
    );

    await waitFor(() => {
      expect(startPlanChange).toHaveBeenCalledTimes(1);
    });
    expect(navigateBillingInSameTab).toHaveBeenCalledWith(
      "https://stripe.test/checkout",
    );
  });

  it("auto-checks out starter deep links during an active starter trial", async () => {
    const startPlanChange = vi.fn().mockResolvedValue({
      kind: "checkout",
      checkoutUrl: "https://stripe.test/checkout",
    });
    mockUseOrganizationBilling.mockReturnValue(
      createBillingHookState({
        billingStatus: billingStatusFixture({
          plan: "free",
          effectivePlan: "starter",
          source: "trial",
          trialStatus: "active",
          trialPlan: "starter",
          trialEndsAt: Date.parse("2026-04-08T00:00:00.000Z"),
          trialDaysRemaining: 7,
        }),
        startPlanChange,
      }),
    );

    const navigateBillingInSameTab = vi.fn();
    const onCheckoutIntentConsumed = vi.fn();

    renderAutoCheckoutTab({
      checkoutIntent: {
        organizationId: "org-1",
        plan: "starter",
        interval: "annual",
      },
      onCheckoutIntentConsumed,
      navigateBillingInSameTab,
    });

    expect(
      screen.getByTestId("billing-deep-link-redirect"),
    ).toBeInTheDocument();

    await waitFor(() => {
      expect(startPlanChange).toHaveBeenCalledWith(
        expect.stringContaining("#organizations/org-1/billing"),
        "starter",
        "annual",
        { confirmPaidPlanChange: false },
      );
    });
    await waitFor(() => {
      expect(onCheckoutIntentConsumed).toHaveBeenCalled();
    });
    expect(navigateBillingInSameTab).toHaveBeenCalledWith(
      "https://stripe.test/checkout",
    );
    expect(
      screen.queryByText("You’re already on this plan"),
    ).not.toBeInTheDocument();
  });

  it("auto-checks out team deep links during an active starter trial", async () => {
    const startPlanChange = vi.fn().mockResolvedValue({
      kind: "checkout",
      checkoutUrl: "https://stripe.test/checkout",
    });
    mockUseOrganizationBilling.mockReturnValue(
      createBillingHookState({
        billingStatus: billingStatusFixture({
          plan: "free",
          effectivePlan: "starter",
          source: "trial",
          trialStatus: "active",
          trialPlan: "starter",
          trialEndsAt: Date.parse("2026-04-08T00:00:00.000Z"),
          trialDaysRemaining: 7,
        }),
        startPlanChange,
      }),
    );

    const navigateBillingInSameTab = vi.fn();
    const onCheckoutIntentConsumed = vi.fn();

    renderAutoCheckoutTab({
      checkoutIntent: {
        organizationId: "org-1",
        plan: "team",
        interval: "monthly",
      },
      onCheckoutIntentConsumed,
      navigateBillingInSameTab,
    });

    await waitFor(() => {
      expect(startPlanChange).toHaveBeenCalledWith(
        expect.stringContaining("#organizations/org-1/billing"),
        "team",
        "monthly",
        { confirmPaidPlanChange: false },
      );
    });
    await waitFor(() => {
      expect(onCheckoutIntentConsumed).toHaveBeenCalled();
    });
    expect(navigateBillingInSameTab).toHaveBeenCalledWith(
      "https://stripe.test/checkout",
    );
  });

  it("consumes billing deep-link checkout intent when billing is unavailable", async () => {
    const startPlanChange = vi.fn();
    mockUseOrganizationBilling.mockReturnValue(
      createBillingHookState({
        billingStatus: billingStatusFixture({
          billingConfigured: false,
          canManageBilling: false,
        }),
        startPlanChange,
      }),
    );

    const onCheckoutIntentConsumed = vi.fn();

    renderAutoCheckoutTab({ onCheckoutIntentConsumed });

    await waitFor(() => {
      expect(onCheckoutIntentConsumed).toHaveBeenCalled();
    });
    await waitFor(() => {
      expect(
        screen.queryByTestId("billing-deep-link-redirect"),
      ).not.toBeInTheDocument();
    });
    expect(startPlanChange).not.toHaveBeenCalled();
    expect(
      screen.getByText(
        "Billing is not configured in this environment. Plans are visible, but purchase actions are unavailable.",
      ),
    ).toBeInTheDocument();
  });

  it("consumes paid deep links without auto-starting a plan change", async () => {
    const startPlanChange = vi.fn();
    mockUseOrganizationBilling.mockReturnValue(
      createBillingHookState({
        billingStatus: billingStatusFixture({
          plan: "starter",
          effectivePlan: "starter",
          source: "subscription",
          billingInterval: "monthly",
          subscriptionStatus: "active",
          hasCustomer: true,
          stripePriceId: "price_starter",
        }),
        startPlanChange,
      }),
    );

    const onCheckoutIntentConsumed = vi.fn();

    renderAutoCheckoutTab({
      checkoutIntent: {
        organizationId: "org-1",
        plan: "team",
        interval: "annual",
      },
      onCheckoutIntentConsumed,
    });

    await waitFor(() => {
      expect(onCheckoutIntentConsumed).toHaveBeenCalled();
    });
    await waitFor(() => {
      expect(
        screen.queryByTestId("billing-deep-link-redirect"),
      ).not.toBeInTheDocument();
    });
    expect(startPlanChange).not.toHaveBeenCalled();
    expect(screen.getByText(/\$49/)).toBeInTheDocument();
  });

  it("consumes paid deep links before subscription status catches up", async () => {
    const startPlanChange = vi.fn();
    mockUseOrganizationBilling.mockReturnValue(
      createBillingHookState({
        billingStatus: billingStatusFixture({
          plan: "starter",
          effectivePlan: "starter",
          billingInterval: "monthly",
          subscriptionStatus: null,
          hasCustomer: true,
          stripePriceId: "price_starter",
        }),
        startPlanChange,
      }),
    );

    const onCheckoutIntentConsumed = vi.fn();

    renderAutoCheckoutTab({
      checkoutIntent: {
        organizationId: "org-1",
        plan: "team",
        interval: "monthly",
      },
      onCheckoutIntentConsumed,
    });

    await waitFor(() => {
      expect(onCheckoutIntentConsumed).toHaveBeenCalled();
    });
    await waitFor(() => {
      expect(
        screen.queryByTestId("billing-deep-link-redirect"),
      ).not.toBeInTheDocument();
    });
    expect(startPlanChange).not.toHaveBeenCalled();
  });

  it("consumes billing deep-link checkout intent when auto-checkout startup fails", async () => {
    const startPlanChange = vi
      .fn()
      .mockRejectedValue(new Error("Failed to change plan"));
    mockUseOrganizationBilling.mockReturnValue(
      createBillingHookState({
        billingStatus: billingStatusFixture(),
        startPlanChange,
      }),
    );

    const navigateBillingInSameTab = vi.fn();
    const onCheckoutIntentConsumed = vi.fn();

    renderAutoCheckoutTab({
      onCheckoutIntentConsumed,
      navigateBillingInSameTab,
    });

    await waitFor(() => {
      expect(startPlanChange).toHaveBeenCalledWith(
        expect.stringContaining("#organizations/org-1/billing"),
        "starter",
        "annual",
        { confirmPaidPlanChange: false },
      );
    });
    await waitFor(() => {
      expect(onCheckoutIntentConsumed).toHaveBeenCalled();
    });
    await waitFor(() => {
      expect(
        screen.queryByTestId("billing-deep-link-redirect"),
      ).not.toBeInTheDocument();
    });
    expect(navigateBillingInSameTab).not.toHaveBeenCalled();
  });

  it("opens the cadence-change portal flow from the overview current plan card", async () => {
    const openIntervalChangePortal = vi
      .fn()
      .mockResolvedValue("https://stripe.test/portal/interval");
    const openPortal = vi.fn().mockResolvedValue("https://stripe.test/portal");
    mockUseOrganizationBilling.mockReturnValue(
      createBillingHookState({
        billingStatus: billingStatusFixture({
          plan: "team",
          effectivePlan: "team",
          billingInterval: "monthly",
          subscriptionStatus: "active",
          hasCustomer: true,
          stripePriceId: "price_123",
        }),
        openPortal,
        openIntervalChangePortal,
      }),
    );

    const openSpy = vi.spyOn(window, "open").mockImplementation(() => null);

    render(<OrganizationsTab organizationId="org-1" />);

    fireEvent.click(screen.getByRole("button", { name: "Change to annual" }));

    await waitFor(() => {
      expect(openIntervalChangePortal).toHaveBeenCalledWith(
        expect.stringContaining("#organizations/org-1/billing"),
        "annual",
      );
    });
    expect(openPortal).not.toHaveBeenCalled();
    expect(openSpy).toHaveBeenCalledWith(
      "https://stripe.test/portal/interval",
      "_blank",
      "noopener,noreferrer",
    );
    openSpy.mockRestore();
  });

  it("opens the billing portal from the overview current plan card for paid owners", async () => {
    const openPortal = vi.fn().mockResolvedValue("https://stripe.test/portal");
    mockUseOrganizationBilling.mockReturnValue(
      createBillingHookState({
        billingStatus: billingStatusFixture({
          plan: "starter",
          effectivePlan: "starter",
          billingInterval: "monthly",
          subscriptionStatus: "active",
          hasCustomer: true,
          stripePriceId: "price_123",
        }),
        openPortal,
      }),
    );

    const openSpy = vi.spyOn(window, "open").mockImplementation(() => null);

    render(<OrganizationsTab organizationId="org-1" />);

    fireEvent.click(screen.getByRole("button", { name: "Manage plan" }));

    await waitFor(() => {
      expect(openPortal).toHaveBeenCalledWith(
        expect.stringContaining("#organizations/org-1/billing"),
      );
    });
    expect(openSpy).toHaveBeenCalledWith(
      "https://stripe.test/portal",
      "_blank",
      "noopener,noreferrer",
    );
    openSpy.mockRestore();
  });

  it("suppresses purchase actions when billing is unconfigured", () => {
    mockUseOrganizationBilling.mockReturnValue(
      createBillingHookState({
        billingStatus: billingStatusFixture({
          billingConfigured: false,
          canManageBilling: false,
        }),
      }),
    );

    render(<OrganizationsTab organizationId="org-1" section="billing" />);

    expect(
      screen.getByText(
        "Billing is not configured in this environment. Plans are visible, but purchase actions are unavailable.",
      ),
    ).toBeInTheDocument();
    for (const button of screen.getAllByRole("button", {
      name: "Upgrade",
    })) {
      expect(button).toBeDisabled();
    }
    expect(screen.getByRole("button", { name: "Talk to sales" })).toBeEnabled();
  });

  it("locks audit log behind enterprise after enforcement becomes active", () => {
    mockUseOrganizationBilling.mockReturnValue(
      createBillingHookState({
        billingStatus: billingStatusFixture({
          plan: "team",
          effectivePlan: "team",
          billingInterval: "monthly",
          subscriptionStatus: "active",
          hasCustomer: true,
          stripePriceId: "price_123",
        }),
        entitlements: {
          plan: "team",
          billingInterval: "monthly",
          source: "subscription",
          features: {
            evals: true,
            chatboxes: true,
            cicd: true,
            customDomains: true,
            auditLog: false,
            sso: false,
            prioritySupport: true,
          },
          limits: {},
        },
        organizationPremiumness: {
          plan: "team",
          enforcementState: "active",
          effectivePlan: "team",
          billingInterval: "monthly",
          source: "subscription",
          decisionRequired: false,
          gates: [
            {
              gateKey: "auditLog",
              kind: "feature",
              scope: "organization",
              canAccess: false,
              shouldShowUpsell: true,
              upgradePlan: "enterprise",
              reason: "feature_not_included",
            },
          ],
        },
        isLoadingBilling: false,
        isLoadingEntitlements: false,
        isLoadingOrganizationPremiumness: false,
        isStartingPlanChange: false,
        isOpeningPortal: false,
        error: null,
        startPlanChange: vi.fn(),
        openPortal: vi.fn(),
      }),
    );

    render(<OrganizationsTab organizationId="org-1" />);

    expect(
      screen.getByText("Audit Log requires Enterprise"),
    ).toBeInTheDocument();
    expect(
      screen.queryByTestId("organization-audit-log"),
    ).not.toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "View billing options" }),
    ).toBeInTheDocument();
  });

  it("skips the audit-log loading placeholder when the billing UI flag is off", () => {
    mockUseFeatureFlagEnabled.mockReturnValue(false);
    mockUseOrganizationBilling.mockReturnValue(
      createBillingHookState({
        billingStatus: billingStatusFixture({
          plan: "team",
          effectivePlan: "team",
          billingInterval: "monthly",
          subscriptionStatus: "active",
          hasCustomer: true,
          stripePriceId: "price_123",
        }),
        isLoadingEntitlements: true,
        isLoadingOrganizationPremiumness: true,
      }),
    );

    render(<OrganizationsTab organizationId="org-1" />);

    expect(
      screen.queryByText("Loading audit log access..."),
    ).not.toBeInTheDocument();
    expect(screen.getByTestId("organization-audit-log")).toBeInTheDocument();
  });

  it("calls onOrganizationDeleted and skips the fallback redirect when provided", async () => {
    window.history.replaceState({}, "", "/#organizations/org-1");
    const onOrganizationDeleted = vi.fn();
    deleteOrganizationMock.mockResolvedValue(undefined);
    mockUseOrganizationBilling.mockReturnValue(
      createBillingHookState({
        billingStatus: billingStatusFixture({ plan: "free" }),
      }),
    );

    render(
      <OrganizationsTab
        organizationId="org-1"
        onOrganizationDeleted={onOrganizationDeleted}
      />,
    );

    fireEvent.click(
      screen.getByRole("button", { name: "Delete Organization" }),
    );

    const dialog = await screen.findByRole("alertdialog");
    fireEvent.click(
      within(dialog).getByRole("button", { name: "Delete Organization" }),
    );

    await waitFor(() => {
      expect(deleteOrganizationMock).toHaveBeenCalledWith({
        organizationId: "org-1",
      });
    });
    await waitFor(() => {
      expect(onOrganizationDeleted).toHaveBeenCalledWith("org-1");
    });

    expect(window.location.hash).toBe("#organizations/org-1");
  });
});
