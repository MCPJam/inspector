import { useState } from "react";
import { describe, expect, it, beforeEach, vi } from "vitest";
import { errorToastMessage } from "@/test/utils";
import {
  act,
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
          evals: true,
          scenarios: true,
          cicd: false,
          customDomains: false,
          auditLog: false,
          sso: false,
          prioritySupport: false,
        },
        limits: {
          maxMembers: null,
          maxProjects: null,
          maxScenariosPerProject: null,
          maxEvalRunsPerMonth: null,
          insightsPerDay: null,
        },
        includedSeats: null,
        seatMinimum: null,
        checkout: null,
      },
      team: {
        plan: "team",
        displayName: "Team",
        billingModel: "per_seat",
        isSelfServe: true,
        prices: { monthly: 3800, annual: 36000 },
        features: {
          evals: true,
          scenarios: true,
          cicd: true,
          customDomains: true,
          auditLog: false,
          sso: false,
          prioritySupport: true,
        },
        limits: {
          maxMembers: null,
          maxProjects: null,
          maxScenariosPerProject: null,
          maxEvalRunsPerMonth: null,
          insightsPerDay: null,
        },
        includedSeats: null,
        seatMinimum: null,
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
          scenarios: true,
          cicd: true,
          customDomains: true,
          auditLog: true,
          sso: true,
          prioritySupport: true,
        },
        limits: {
          maxMembers: null,
          maxProjects: null,
          maxScenariosPerProject: null,
          maxEvalRunsPerMonth: null,
          insightsPerDay: null,
        },
        includedSeats: null,
        seatMinimum: null,
        checkout: null,
      },
    },
  };
}

function billingStatusFixture(
  overrides: Record<string, unknown> = {}
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
    deferredTrialBillingStartsAt: null,
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
    projectPremiumness: undefined,
    activeSeatPaymentIntent: null,
    planCatalog: createPlanCatalog(),
    isLoadingBilling: false,
    isLoadingEntitlements: false,
    isLoadingOrganizationPremiumness: false,
    isLoadingProjectPremiumness: false,
    isLoadingPlanCatalog: false,
    isStartingPlanChange: false,
    pendingPlanChangeTarget: null,
    isOpeningPortal: false,
    isCancelingScheduledBillingChange: false,
    isSelectingFreeAfterTrial: false,
    isHandlingSeatPayment: false,
    error: null,
    startPlanChange: vi.fn(),
    openPortal: vi.fn(),
    openCancellationPortal: vi.fn(),
    openIntervalChangePortal: vi.fn(),
    cancelScheduledBillingChange: vi.fn(),
    selectFreeAfterTrial: vi.fn(),
    finishSeatPayment: vi.fn(),
    cancelSeatPayment: vi.fn(),
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
      plan: "team",
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
  useQuery: () => undefined,
}));

vi.mock("@/hooks/useOrgSharePolicy", () => ({
  useOrgSharePolicy: () => ({
    policy: {
      maxShareMode: "anyone_with_link",
      inviteAudience: "anyone",
      updatedAt: null,
    },
    isLoading: false,
    error: null,
    isSaving: false,
    setPolicy: vi.fn(),
  }),
  useEffectiveSharePolicy: () => ({ policy: undefined, isLoading: false }),
}));

vi.mock("posthog-js/react", () => ({
  useFeatureFlagEnabled: (...args: unknown[]) =>
    mockUseFeatureFlagEnabled(...args),
  usePostHog: () => undefined,
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

// Stripe-backed invoice hook used by the merged payment-history section; stub
// it empty so these org-tab tests don't reach the action layer.
vi.mock("@/hooks/useInvoiceHistory", () => ({
  useInvoiceHistory: () => ({
    entries: [],
    upcoming: null,
    isLoading: false,
    error: null,
  }),
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

  it("shows the current plan summary in the billing view", () => {
    mockUseOrganizationBilling.mockReturnValue(
      createBillingHookState({
        billingStatus: billingStatusFixture({ plan: "free" }),
      })
    );

    render(<OrganizationsTab organizationId="org-1" section="billing" />);

    const panel = within(screen.getByTestId("current-plan-panel"));
    expect(screen.getByRole("button", { name: "Billing" })).toBeInTheDocument();
    expect(panel.getByText("Billing cycle")).toBeInTheDocument();
    expect(panel.queryByText("Subscription status")).not.toBeInTheDocument();
    expect(screen.getByTestId("current-plan-renewal")).toHaveTextContent(
      "No active subscription"
    );
  });

  it("shows pending seat payment notice in the billing view", async () => {
    const finishSeatPayment = vi
      .fn()
      .mockResolvedValue({ status: "paid", seatQuantity: 4 });
    mockUseOrganizationBilling.mockReturnValue(
      createBillingHookState({
        billingStatus: billingStatusFixture({
          plan: "team",
          effectivePlan: "team",
          source: "subscription",
          billingInterval: "monthly",
          subscriptionStatus: "active",
          hasCustomer: true,
          stripePriceId: "price_team_monthly",
        }),
        activeSeatPaymentIntent: {
          _id: "seat-payment-1",
          organizationId: "org-1",
          userId: "user-new",
          email: "new@example.com",
          role: "member",
          source: "workspace",
          status: "pending",
          targetSeatQuantity: null,
          stripeInvoiceId: null,
          createdAt: 1,
          updatedAt: 2,
        },
        finishSeatPayment,
      })
    );

    render(<OrganizationsTab organizationId="org-1" section="billing" />);

    expect(screen.getByTestId("pending-seat-payment-notice")).toHaveTextContent(
      "Finish payment to add new@example.com"
    );

    fireEvent.click(screen.getByRole("button", { name: "Finish payment" }));
    await waitFor(() =>
      expect(finishSeatPayment).toHaveBeenCalledWith(undefined)
    );
  });

  const failedSeatPaymentIntentFixture = () => ({
    _id: "seat-payment-failed",
    organizationId: "org-1",
    userId: "user-new",
    email: "stranded@example.com",
    role: "member" as const,
    source: "pending_invite_signup",
    status: "failed" as const,
    needsRetry: true,
    targetSeatQuantity: null,
    stripeInvoiceId: null,
    createdAt: 1,
    updatedAt: 2,
  });

  const pendingSeatPaymentIntentFixture = () => ({
    _id: "seat-payment-pending",
    organizationId: "org-1",
    userId: "user-new",
    email: "new@example.com",
    role: "member" as const,
    source: "pending_invite_signup",
    status: "requires_action" as const,
    targetSeatQuantity: 4,
    stripeInvoiceId: "in_123",
    createdAt: 1,
    updatedAt: 2,
  });

  it("does not claim success when Stripe defers seat cancellation", async () => {
    const cancelSeatPayment = vi.fn().mockResolvedValue({
      voided: false,
      outcome: "deferred",
    });
    mockUseOrganizationBilling.mockReturnValue(
      createBillingHookState({
        billingStatus: billingStatusFixture({
          plan: "team",
          effectivePlan: "team",
          source: "subscription",
          billingInterval: "monthly",
          subscriptionStatus: "active",
          hasCustomer: true,
          stripePriceId: "price_team_monthly",
        }),
        activeSeatPaymentIntent: pendingSeatPaymentIntentFixture(),
        cancelSeatPayment,
      })
    );

    render(<OrganizationsTab organizationId="org-1" section="billing" />);
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));

    await waitFor(() =>
      expect(toast.error).toHaveBeenCalledWith(
        errorToastMessage(
          "Stripe could not confirm cancellation yet. The payment is still pending; try again."
        ),
        { duration: 8000 }
      )
    );
    expect(toast.success).not.toHaveBeenCalled();
  });

  // A charge raised automatically when an invitee signs up fails with nobody
  // watching. Before this, terminal charges were invisible to the owner and
  // the invitee stayed stranded — the original bug with a nicer tooltip.
  it("surfaces a failed seat charge with a working retry", async () => {
    const retrySeatPayment = vi
      .fn()
      .mockResolvedValue({ status: "paid", seatQuantity: 4 });
    const finishSeatPayment = vi.fn();
    mockUseOrganizationBilling.mockReturnValue(
      createBillingHookState({
        billingStatus: billingStatusFixture({
          plan: "team",
          effectivePlan: "team",
          source: "subscription",
          billingInterval: "monthly",
          subscriptionStatus: "active",
          hasCustomer: true,
          stripePriceId: "price_team_monthly",
        }),
        activeSeatPaymentIntent: {
          _id: "seat-payment-failed",
          organizationId: "org-1",
          userId: "user-new",
          email: "stranded@example.com",
          role: "member",
          source: "pending_invite_signup",
          status: "failed",
          needsRetry: true,
          targetSeatQuantity: null,
          stripeInvoiceId: null,
          createdAt: 1,
          updatedAt: 2,
        },
        finishSeatPayment,
        retrySeatPayment,
      })
    );

    render(<OrganizationsTab organizationId="org-1" section="billing" />);

    expect(screen.getByTestId("failed-seat-payment-notice")).toHaveTextContent(
      "stranded@example.com"
    );

    fireEvent.click(screen.getByRole("button", { name: "Retry payment" }));
    await waitFor(() => expect(retrySeatPayment).toHaveBeenCalled());
    // Retry reopens the charge as a new attempt first; going straight to
    // finish would be refused, since terminal charges are not revivable there.
    expect(finishSeatPayment).not.toHaveBeenCalled();
  });

  it("disables Retry until declined-invoice cleanup is confirmed", () => {
    const retrySeatPayment = vi.fn();
    mockUseOrganizationBilling.mockReturnValue(
      createBillingHookState({
        billingStatus: billingStatusFixture({
          plan: "team",
          effectivePlan: "team",
          source: "subscription",
          billingInterval: "monthly",
          subscriptionStatus: "active",
          hasCustomer: true,
          stripePriceId: "price_team_monthly",
        }),
        activeSeatPaymentIntent: {
          ...failedSeatPaymentIntentFixture(),
          status: "cleanup_pending",
          stripeInvoiceId: "in_declined",
        },
        retrySeatPayment,
      })
    );

    render(<OrganizationsTab organizationId="org-1" section="billing" />);

    expect(screen.getByText(/Retry will unlock/)).toBeInTheDocument();
    const retryButton = screen.getByRole("button", { name: "Retry payment" });
    expect(retryButton).toBeDisabled();
    expect(screen.getByRole("button", { name: "Remove invite" })).toBeEnabled();
    fireEvent.click(retryButton);
    expect(retrySeatPayment).not.toHaveBeenCalled();
  });

  it("shows an error and no success toast when a retry is rejected", async () => {
    const retrySeatPayment = vi
      .fn()
      .mockRejectedValue(
        new Error("Payment failed. The member was not added.")
      );
    mockUseOrganizationBilling.mockReturnValue(
      createBillingHookState({
        billingStatus: billingStatusFixture({
          plan: "team",
          effectivePlan: "team",
          source: "subscription",
          billingInterval: "monthly",
          subscriptionStatus: "active",
          hasCustomer: true,
          stripePriceId: "price_team_monthly",
        }),
        activeSeatPaymentIntent: failedSeatPaymentIntentFixture(),
        retrySeatPayment,
      })
    );

    render(<OrganizationsTab organizationId="org-1" section="billing" />);
    fireEvent.click(screen.getByRole("button", { name: "Retry payment" }));

    await waitFor(() =>
      expect(toast.error).toHaveBeenCalledWith(
        errorToastMessage("Payment failed. The member was not added."),
        { duration: 8000 }
      )
    );
    expect(toast.success).not.toHaveBeenCalled();
  });

  it("shows an error when the charge can no longer be retried", async () => {
    // retrySeatPayment resolves undefined when the cancel-version guard trips
    // or the backend has nothing retryable left. Silence here would leave the
    // owner thinking it worked.
    const retrySeatPayment = vi.fn().mockResolvedValue(undefined);
    mockUseOrganizationBilling.mockReturnValue(
      createBillingHookState({
        billingStatus: billingStatusFixture({
          plan: "team",
          effectivePlan: "team",
          source: "subscription",
          billingInterval: "monthly",
          subscriptionStatus: "active",
          hasCustomer: true,
          stripePriceId: "price_team_monthly",
        }),
        activeSeatPaymentIntent: failedSeatPaymentIntentFixture(),
        retrySeatPayment,
      })
    );

    render(<OrganizationsTab organizationId="org-1" section="billing" />);
    fireEvent.click(screen.getByRole("button", { name: "Retry payment" }));

    await waitFor(() => expect(retrySeatPayment).toHaveBeenCalled());
    expect(toast.success).not.toHaveBeenCalled();
  });

  it("keeps Remove invite available while a retry is in flight", () => {
    // Cancelling mid-retry stays possible on purpose — the owner may be stuck
    // in a 3DS modal that never resolves and needs a way out. Safety comes
    // from retrySeatPayment's cancel-version guard, which refuses to reopen
    // payment on a charge that was cancelled underneath it, not from taking
    // the escape hatch away.
    mockUseOrganizationBilling.mockReturnValue(
      createBillingHookState({
        billingStatus: billingStatusFixture({
          plan: "team",
          effectivePlan: "team",
          source: "subscription",
          billingInterval: "monthly",
          subscriptionStatus: "active",
          hasCustomer: true,
          stripePriceId: "price_team_monthly",
        }),
        activeSeatPaymentIntent: failedSeatPaymentIntentFixture(),
        isFinishingSeatPayment: true,
      })
    );

    render(<OrganizationsTab organizationId="org-1" section="billing" />);

    expect(screen.getByRole("button", { name: "Remove invite" })).toBeEnabled();
  });

  it("Remove invite removes the invite instead of cancelling a dead charge", async () => {
    // cancelSeatPayment returns immediately for anything not still active, so
    // routing this path through it left everything untouched but claimed
    // success.
    const cancelSeatPayment = vi.fn();
    mockUseOrganizationBilling.mockReturnValue(
      createBillingHookState({
        billingStatus: billingStatusFixture({
          plan: "team",
          effectivePlan: "team",
          source: "subscription",
          billingInterval: "monthly",
          subscriptionStatus: "active",
          hasCustomer: true,
          stripePriceId: "price_team_monthly",
        }),
        activeSeatPaymentIntent: failedSeatPaymentIntentFixture(),
        cancelSeatPayment,
      })
    );

    render(<OrganizationsTab organizationId="org-1" section="billing" />);
    fireEvent.click(screen.getByRole("button", { name: "Remove invite" }));

    await waitFor(() =>
      expect(removeMemberMock).toHaveBeenCalledWith({
        organizationId: "org-1",
        email: "stranded@example.com",
      })
    );
    expect(cancelSeatPayment).not.toHaveBeenCalled();
  });

  it("ignores repeated Remove invite clicks", async () => {
    // Without a guard a second removeMember finds no row and reports "Member
    // not found" on top of the first one's success. This covers the guard as a
    // whole; it cannot tell the disabled button apart from the ref, since
    // fireEvent flushes the state update between clicks.
    let resolveRemoval: () => void = () => {};
    removeMemberMock.mockImplementation(
      () =>
        new Promise<void>((resolve) => {
          resolveRemoval = () => resolve();
        })
    );
    mockUseOrganizationBilling.mockReturnValue(
      createBillingHookState({
        billingStatus: billingStatusFixture({
          plan: "team",
          effectivePlan: "team",
          source: "subscription",
          billingInterval: "monthly",
          subscriptionStatus: "active",
          hasCustomer: true,
          stripePriceId: "price_team_monthly",
        }),
        activeSeatPaymentIntent: failedSeatPaymentIntentFixture(),
      })
    );

    render(<OrganizationsTab organizationId="org-1" section="billing" />);
    const button = screen.getByRole("button", { name: "Remove invite" });
    fireEvent.click(button);
    fireEvent.click(button);
    fireEvent.click(button);

    await waitFor(() => expect(removeMemberMock).toHaveBeenCalledTimes(1));
    await act(async () => {
      resolveRemoval();
    });
  });

  it("surfaces an error when removing the invite fails", async () => {
    removeMemberMock.mockRejectedValue(new Error("Member not found"));
    mockUseOrganizationBilling.mockReturnValue(
      createBillingHookState({
        billingStatus: billingStatusFixture({
          plan: "team",
          effectivePlan: "team",
          source: "subscription",
          billingInterval: "monthly",
          subscriptionStatus: "active",
          hasCustomer: true,
          stripePriceId: "price_team_monthly",
        }),
        activeSeatPaymentIntent: failedSeatPaymentIntentFixture(),
      })
    );

    render(<OrganizationsTab organizationId="org-1" section="billing" />);
    fireEvent.click(screen.getByRole("button", { name: "Remove invite" }));

    await waitFor(() => expect(toast.error).toHaveBeenCalled());
    expect(toast.success).not.toHaveBeenCalled();

    // The guard released, so a corrected retry is still possible.
    removeMemberMock.mockResolvedValue(undefined);
    fireEvent.click(screen.getByRole("button", { name: "Remove invite" }));
    await waitFor(() => expect(removeMemberMock).toHaveBeenCalledTimes(2));
  });

  it("billing view hides Manage plan for non-owners and shows owner-only copy", () => {
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
      })
    );

    render(<OrganizationsTab organizationId="org-1" section="billing" />);

    expect(screen.queryByRole("button", { name: "Manage plan" })).toBeNull();
    expect(
      screen.getByText("Only organization owners can manage billing.")
    ).toBeInTheDocument();
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
      })
    );

    render(<OrganizationsTab organizationId="org-1" section="billing" />);

    expect(screen.getByTestId("current-plan-renewal")).toHaveTextContent(
      "Cancels May 1, 2026"
    );
    expect(
      screen.getByTestId("current-plan-non-renewing-badge")
    ).toHaveTextContent("Will not renew");
    expect(
      screen.getByTestId("current-plan-scheduled-cancel")
    ).toHaveTextContent("Service ends May 1, 2026. Will not renew.");
    expect(screen.queryByText(/Renews /)).not.toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "Change to annual" })
    ).not.toBeInTheDocument();
  });

  it("shows 'First charge' copy while the subscription is trialing", () => {
    mockUseOrganizationBilling.mockReturnValue(
      createBillingHookState({
        billingStatus: billingStatusFixture({
          plan: "team",
          effectivePlan: "team",
          billingInterval: "monthly",
          subscriptionStatus: "trialing",
          source: "subscription",
          hasCustomer: true,
          stripeCurrentPeriodEnd: Date.parse("2026-05-19T12:00:00.000Z"),
          stripePriceId: "price_team_monthly",
        }),
      })
    );

    render(<OrganizationsTab organizationId="org-1" section="billing" />);

    expect(screen.getByTestId("current-plan-renewal")).toHaveTextContent(
      "First charge May 19, 2026"
    );
    expect(screen.queryByText(/Renews /)).not.toBeInTheDocument();
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
      })
    );

    render(<OrganizationsTab organizationId="org-1" section="billing" />);

    const panel = within(screen.getByTestId("current-plan-panel"));
    expect(
      panel.getByText("$30 per seat/month, billed annually")
    ).toBeInTheDocument();
    expect(
      panel.queryByText("Billing details are updating…")
    ).not.toBeInTheDocument();
  });

  it("shows a scheduled interval change and offers a same-tier reversal CTA", () => {
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
          stripeScheduledPlan: "team",
          stripeScheduledBillingInterval: "monthly",
          stripeScheduledPriceId: "price_team_monthly",
          stripeScheduledEffectiveAt: Date.parse("2027-04-01T12:00:00.000Z"),
          canCancelScheduledBillingChange: true,
        }),
      })
    );

    render(<OrganizationsTab organizationId="org-1" section="billing" />);

    expect(screen.getByTestId("current-plan-renewal")).toHaveTextContent(
      "Changes Apr 1, 2027"
    );
    expect(
      screen.getByTestId("current-plan-scheduled-change")
    ).toHaveTextContent("Monthly billing starts Apr 1, 2027.");
    expect(
      screen.queryByRole("button", { name: "Change to monthly" })
    ).not.toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "Keep Team annual plan" })
    ).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "Manage plan" })
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

    const view = render(
      <OrganizationsTab organizationId="org-1" section="billing" />
    );

    fireEvent.click(
      screen.getByRole("button", { name: "Keep Team annual plan" })
    );

    expect(
      screen.getByRole("heading", { name: "Keep Team annual plan?" })
    ).toBeInTheDocument();
    expect(
      screen.getByText(
        "This cancels the pending switch to monthly billing on Apr 1, 2027. Team annual remains active."
      )
    ).toBeInTheDocument();

    fireEvent.click(
      within(screen.getByRole("alertdialog")).getByRole("button", {
        name: "Keep Team annual plan",
      })
    );

    await waitFor(() => {
      expect(cancelScheduledBillingChange).toHaveBeenCalledTimes(1);
    });
    expect(toast.success).toHaveBeenCalledWith(
      "Scheduled billing change canceled. Team annual remains active."
    );

    view.rerender(
      <OrganizationsTab organizationId="org-1" section="billing" />
    );

    expect(
      screen.queryByTestId("current-plan-scheduled-change")
    ).not.toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "Change to monthly" })
    ).toBeInTheDocument();
  });

  it("shows trial messaging without paid Team pricing copy for active trials", () => {
    mockUseOrganizationBilling.mockReturnValue(
      createBillingHookState({
        billingStatus: billingStatusFixture({
          plan: "free",
          effectivePlan: "team",
          source: "trial",
          trialStatus: "active",
          trialPlan: "team",
          trialStartedAt: Date.parse("2026-04-01T00:00:00.000Z"),
          trialEndsAt: Date.parse("2026-04-08T00:00:00.000Z"),
        }),
      })
    );

    render(<OrganizationsTab organizationId="org-1" section="billing" />);

    const panel = within(screen.getByTestId("current-plan-panel"));
    expect(panel.getByText("Team Trial")).toBeInTheDocument();
    expect(
      panel.getByText("7-day trial · no active subscription yet")
    ).toBeInTheDocument();
    expect(screen.getByTestId("current-plan-renewal")).toHaveTextContent(
      "Trial ends"
    );
    expect(
      panel.queryByText(/flat monthly rate|per seat\/month/i)
    ).not.toBeInTheDocument();
  });

  it("shows simulated effective plans with an explicit simulation banner", () => {
    mockUseOrganizationBilling.mockReturnValue(
      createBillingHookState({
        billingStatus: billingStatusFixture({
          plan: "free",
          effectivePlan: "team",
          source: "simulation",
        }),
      })
    );

    render(<OrganizationsTab organizationId="org-1" section="billing" />);

    const panel = within(screen.getByTestId("current-plan-panel"));
    expect(panel.getByText("Team")).toBeInTheDocument();
    expect(
      panel.getByText(
        "Simulation active. Limits and access use Team, while billing remains on Free."
      )
    ).toBeInTheDocument();
    expect(
      panel.getByText("Simulation active · billing changes are not applied")
    ).toBeInTheDocument();
  });

  it("hides the overview billing card when the billing UI flag is off", () => {
    mockUseFeatureFlagEnabled.mockReturnValue(false);
    mockUseOrganizationBilling.mockReturnValue(
      createBillingHookState({
        billingStatus: billingStatusFixture({
          plan: "team",
          effectivePlan: "team",
          billingInterval: "monthly",
          subscriptionStatus: "active",
          hasCustomer: true,
          stripeCurrentPeriodEnd: 1_705_000_000_000,
          stripePriceId: "price_123",
        }),
      })
    );

    render(<OrganizationsTab organizationId="org-1" />);

    expect(
      screen.queryByRole("button", { name: "Plans & billing" })
    ).not.toBeInTheDocument();
    expect(screen.queryByText("Billing account")).not.toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "View plans" })
    ).not.toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "Manage plan" })
    ).not.toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "Upgrade plan" })
    ).not.toBeInTheDocument();
  });

  it("shows the billing subview summary and plan cards", () => {
    mockUseOrganizationBilling.mockReturnValue(
      createBillingHookState({
        billingStatus: billingStatusFixture({
          plan: "team",
          effectivePlan: "team",
          billingInterval: "monthly",
          subscriptionStatus: "active",
          hasCustomer: true,
          stripeCurrentPeriodEnd: 1_705_000_000_000,
          stripePriceId: "price_123",
        }),
      })
    );

    render(<OrganizationsTab organizationId="org-1" section="billing" />);

    expect(screen.getByText("Plans & Billing")).toBeInTheDocument();
    expect(screen.getAllByText("Current plan").length).toBeGreaterThan(0);
    expect(screen.getAllByText("Team").length).toBeGreaterThan(0);
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
      })
    );

    render(<OrganizationsTab organizationId="org-1" section="billing" />);

    expect(
      screen.getByText(
        "Only organization owners can manage billing changes. Admins can review plan details here."
      )
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
      })
    );
    addMemberMock.mockRejectedValue(
      new Error(
        JSON.stringify({
          code: "billing_limit_reached",
          limit: "maxMembers",
          allowedValue: 3,
        })
      )
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
      errorToastMessage(
        "This organization has reached its member limit (3). Ask an organization owner to upgrade."
      ),
      { duration: 8000 }
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
              upgradePlan: "team",
              reason: "limit_reached",
              currentValue: 1,
              allowedValue: 1,
            },
          ],
        },
      })
    );

    render(<OrganizationsTab organizationId="org-1" />);

    fireEvent.change(screen.getByPlaceholderText("Email address"), {
      target: { value: "new-user@example.com" },
    });

    expect(screen.getByTestId("member-limit-upsell")).toBeInTheDocument();
    expect(
      screen.getByText(
        "This organization has reached its member limit (1). Upgrade to add more members."
      )
    ).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "Upgrade to Team" })
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
              upgradePlan: "team",
              reason: "limit_reached",
              currentValue: 1,
              allowedValue: 1,
            },
          ],
        },
      })
    );

    render(<OrganizationsTab organizationId="org-1" />);

    expect(screen.getByTestId("member-limit-upsell")).toBeInTheDocument();
    expect(
      screen.getByText("Ask an organization owner to review billing options.")
    ).toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "Upgrade to Team" })
    ).not.toBeInTheDocument();
  });

  it("shows Team as a purchasable upgrade when billing UI is enabled", () => {
    mockUseOrganizationBilling.mockReturnValue(
      createBillingHookState({
        billingStatus: billingStatusFixture({
          plan: "free",
          effectivePlan: "free",
          source: "free",
        }),
      })
    );

    render(<OrganizationsTab organizationId="org-1" section="billing" />);

    expect(screen.queryByText("Coming soon")).not.toBeInTheDocument();
    // Since #2629 a free-plan org sees a dedicated Team upsell card (with its
    // own Upgrade CTA) in addition to the comparison-table column, so an
    // unscoped count is now 2. Scope to the upsell card and assert it offers
    // the purchase affordance — that's what this test is about.
    const upsell = within(screen.getByTestId("free-plan-team-upsell"));
    expect(upsell.getByRole("button", { name: "Upgrade" })).toBeInTheDocument();
  });

  it("updates pricing when the billing interval toggle changes", () => {
    mockUseOrganizationBilling.mockReturnValue(
      createBillingHookState({
        billingStatus: billingStatusFixture(),
      })
    );

    render(<OrganizationsTab organizationId="org-1" section="billing" />);

    // The free-plan Team upsell card (#2629) and the comparison table each
    // render a price + interval toggle backed by the same `billingInterval`
    // state, so global queries are now ambiguous. Drive and assert through the
    // upsell card's own toggle.
    const upsell = within(screen.getByTestId("free-plan-team-upsell"));
    // Default interval is annual — Team lists $30/seat/mo billed annually
    expect(upsell.getByText(/\$30/)).toBeInTheDocument();
    fireEvent.click(upsell.getByRole("button", { name: /^Monthly$/ }));
    expect(upsell.getByText(/\$38/)).toBeInTheDocument();
    fireEvent.click(upsell.getByRole("button", { name: /^Annual$/ }));
    expect(upsell.getByText(/\$30/)).toBeInTheDocument();
  });

  it("shows deferred billing copy for active trials with enough time remaining", () => {
    const now = Date.now();
    const trialEndsAt = now + 10 * 24 * 60 * 60 * 1000;
    mockUseOrganizationBilling.mockReturnValue(
      createBillingHookState({
        billingStatus: billingStatusFixture({
          plan: "free",
          effectivePlan: "team",
          source: "trial",
          trialStatus: "active",
          trialPlan: "team",
          trialStartedAt: now - 24 * 60 * 60 * 1000,
          trialEndsAt,
          deferredTrialBillingStartsAt: trialEndsAt,
          trialDaysRemaining: 10,
        }),
      })
    );

    render(<OrganizationsTab organizationId="org-1" section="billing" />);

    expect(
      screen.getAllByText(/\$0 today\. First bill charged in advance on /)
        .length
    ).toBeGreaterThanOrEqual(1);
  });

  it("hides deferred billing copy when the backend does not return deferred billing eligibility", () => {
    const now = Date.now();
    mockUseOrganizationBilling.mockReturnValue(
      createBillingHookState({
        billingStatus: billingStatusFixture({
          plan: "free",
          effectivePlan: "team",
          source: "trial",
          trialStatus: "active",
          trialPlan: "team",
          trialStartedAt: now - 24 * 60 * 60 * 1000,
          trialEndsAt: now + 36 * 60 * 60 * 1000,
          trialDaysRemaining: 2,
        }),
      })
    );

    render(<OrganizationsTab organizationId="org-1" section="billing" />);

    expect(screen.queryByText(/\$0 today/)).not.toBeInTheDocument();
  });

  it("hides deferred billing copy when upgrade actions are disabled", () => {
    const now = Date.now();
    const trialEndsAt = now + 10 * 24 * 60 * 60 * 1000;
    mockUseOrganizationBilling.mockReturnValue(
      createBillingHookState({
        billingStatus: billingStatusFixture({
          plan: "free",
          effectivePlan: "team",
          source: "trial",
          trialStatus: "active",
          trialPlan: "team",
          trialStartedAt: now - 24 * 60 * 60 * 1000,
          trialEndsAt,
          deferredTrialBillingStartsAt: trialEndsAt,
          trialDaysRemaining: 10,
          canManageBilling: false,
          isOwner: false,
        }),
      })
    );

    render(<OrganizationsTab organizationId="org-1" section="billing" />);

    expect(screen.queryByText(/\$0 today/)).not.toBeInTheDocument();
  });

  it("hides deferred billing copy when there is no active trial", () => {
    mockUseOrganizationBilling.mockReturnValue(
      createBillingHookState({
        billingStatus: billingStatusFixture(),
      })
    );

    render(<OrganizationsTab organizationId="org-1" section="billing" />);

    expect(screen.queryByText(/\$0 today/)).not.toBeInTheDocument();
  });

  it("starts checkout for Team from the billing subview", async () => {
    const startPlanChange = vi.fn().mockResolvedValue({
      kind: "checkout",
      checkoutUrl: "https://stripe.test/checkout",
    });
    mockUseOrganizationBilling.mockReturnValue(
      createBillingHookState({
        billingStatus: billingStatusFixture(),
        startPlanChange,
      })
    );

    const openSpy = vi.spyOn(window, "open").mockImplementation(() => null);

    render(<OrganizationsTab organizationId="org-1" section="billing" />);

    const upgradeButtons = screen.getAllByRole("button", { name: "Upgrade" });
    fireEvent.click(upgradeButtons[0]!);

    await waitFor(() => {
      expect(startPlanChange).toHaveBeenCalledWith(
        expect.stringContaining("/organizations/org-1/billing"),
        "team",
        "annual",
        { confirmPaidPlanChange: true }
      );
    });
    expect(screen.queryByText("Upgrade to Team?")).not.toBeInTheDocument();
    expect(openSpy).toHaveBeenCalledWith(
      "https://stripe.test/checkout",
      "_blank",
      "noopener,noreferrer"
    );
    openSpy.mockRestore();
  });

  it("disables self-serve compare-table actions while a plan change is in flight", () => {
    mockUseOrganizationBilling.mockReturnValue(
      createBillingHookState({
        billingStatus: billingStatusFixture(),
        isStartingPlanChange: true,
        pendingPlanChangeTarget: "team",
      })
    );

    render(<OrganizationsTab organizationId="org-1" section="billing" />);

    // While the change is in flight, the Team column's CTA is disabled.
    // Production renders either "Upgrade" or "Loading..." depending on which
    // tier is in-flight; both should be disabled regardless.
    const teamButtons = within(getPlanColumn("Team")).getAllByRole("button");
    expect(teamButtons.length).toBeGreaterThan(0);
    for (const button of teamButtons) {
      expect(button).toBeDisabled();
    }
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
          plan: "team",
          effectivePlan: "team",
          billingInterval: "annual",
          subscriptionStatus: "active",
          hasCustomer: true,
          stripeCurrentPeriodEnd: Date.parse("2027-04-01T12:00:00.000Z"),
          stripePriceId: "price_team_annual",
        }),
        startPlanChange,
        openPortal,
        openCancellationPortal,
      })
    );

    const openSpy = vi.spyOn(window, "open").mockImplementation(() => null);

    render(<OrganizationsTab organizationId="org-1" section="billing" />);

    fireEvent.click(
      within(getPlanColumn("Free")).getByRole("button", {
        name: "Downgrade",
      })
    );

    expect(screen.getByText("Return to Free at renewal?")).toBeInTheDocument();
    expect(
      screen.getByText(/This cancellation takes effect at renewal, not now\./)
    ).toBeInTheDocument();
    expect(
      screen.getByText(/Team annual remains active until Apr 1, 2027/)
    ).toBeInTheDocument();
    expect(
      screen.getByText(/the organization returns to Free/)
    ).toBeInTheDocument();
    expect(
      screen.getByText(/you can't change your billing interval/)
    ).toBeInTheDocument();

    fireEvent.click(
      screen.getByRole("button", { name: "Open cancellation flow" })
    );

    await waitFor(() => {
      expect(openCancellationPortal).toHaveBeenCalledWith(
        expect.stringContaining("/organizations/org-1/billing")
      );
    });
    expect(startPlanChange).not.toHaveBeenCalled();
    expect(openPortal).not.toHaveBeenCalled();
    expect(openSpy).toHaveBeenCalledWith(
      "https://stripe.test/portal/cancel",
      "_blank",
      "noopener,noreferrer"
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
      })
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
      screen.getByTestId("billing-deep-link-redirect")
    ).toBeInTheDocument();

    await waitFor(() => {
      expect(startPlanChange).toHaveBeenCalledWith(
        expect.stringContaining("/organizations/org-1/billing"),
        "team",
        "annual",
        { confirmPaidPlanChange: false }
      );
    });
    expect(onCheckoutIntentNavigationStarted).toHaveBeenCalled();
    await waitFor(() => {
      expect(onCheckoutIntentConsumed).toHaveBeenCalled();
    });
    expect(navigateBillingInSameTab).toHaveBeenCalledWith(
      "https://stripe.test/checkout"
    );
    expect(openSpy).not.toHaveBeenCalled();
    await waitFor(() => {
      expect(
        screen.queryByTestId("billing-deep-link-redirect")
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
      plan: "team" as const,
      interval: "annual" as const,
    };

    const view = render(
      <OrganizationsTab
        organizationId="org-1"
        section="billing"
        checkoutIntent={checkoutIntent}
        navigateBillingInSameTab={navigateBillingInSameTab}
      />
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
      />
    );

    await waitFor(() => {
      expect(startPlanChange).toHaveBeenCalledTimes(1);
    });
    expect(navigateBillingInSameTab).toHaveBeenCalledWith(
      "https://stripe.test/checkout"
    );
  });

  it("auto-checks out solo deep links during an active solo trial", async () => {
    const startPlanChange = vi.fn().mockResolvedValue({
      kind: "checkout",
      checkoutUrl: "https://stripe.test/checkout",
    });
    mockUseOrganizationBilling.mockReturnValue(
      createBillingHookState({
        billingStatus: billingStatusFixture({
          plan: "free",
          effectivePlan: "team",
          source: "trial",
          trialStatus: "active",
          trialPlan: "team",
          trialEndsAt: Date.parse("2026-04-08T00:00:00.000Z"),
          trialDaysRemaining: 7,
        }),
        startPlanChange,
      })
    );

    const navigateBillingInSameTab = vi.fn();
    const onCheckoutIntentConsumed = vi.fn();

    renderAutoCheckoutTab({
      checkoutIntent: {
        organizationId: "org-1",
        plan: "team",
        interval: "annual",
      },
      onCheckoutIntentConsumed,
      navigateBillingInSameTab,
    });

    expect(
      screen.getByTestId("billing-deep-link-redirect")
    ).toBeInTheDocument();

    await waitFor(() => {
      expect(startPlanChange).toHaveBeenCalledWith(
        expect.stringContaining("/organizations/org-1/billing"),
        "team",
        "annual",
        { confirmPaidPlanChange: false }
      );
    });
    await waitFor(() => {
      expect(onCheckoutIntentConsumed).toHaveBeenCalled();
    });
    expect(navigateBillingInSameTab).toHaveBeenCalledWith(
      "https://stripe.test/checkout"
    );
    expect(
      screen.queryByText("You’re already on this plan")
    ).not.toBeInTheDocument();
  });

  it("auto-checks out team deep links during an active solo trial", async () => {
    const startPlanChange = vi.fn().mockResolvedValue({
      kind: "checkout",
      checkoutUrl: "https://stripe.test/checkout",
    });
    mockUseOrganizationBilling.mockReturnValue(
      createBillingHookState({
        billingStatus: billingStatusFixture({
          plan: "free",
          effectivePlan: "team",
          source: "trial",
          trialStatus: "active",
          trialPlan: "team",
          trialEndsAt: Date.parse("2026-04-08T00:00:00.000Z"),
          trialDaysRemaining: 7,
        }),
        startPlanChange,
      })
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
        expect.stringContaining("/organizations/org-1/billing"),
        "team",
        "monthly",
        { confirmPaidPlanChange: false }
      );
    });
    await waitFor(() => {
      expect(onCheckoutIntentConsumed).toHaveBeenCalled();
    });
    expect(navigateBillingInSameTab).toHaveBeenCalledWith(
      "https://stripe.test/checkout"
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
      })
    );

    const onCheckoutIntentConsumed = vi.fn();

    renderAutoCheckoutTab({ onCheckoutIntentConsumed });

    await waitFor(() => {
      expect(onCheckoutIntentConsumed).toHaveBeenCalled();
    });
    await waitFor(() => {
      expect(
        screen.queryByTestId("billing-deep-link-redirect")
      ).not.toBeInTheDocument();
    });
    expect(startPlanChange).not.toHaveBeenCalled();
    expect(
      screen.getByText(
        "Billing is not configured in this environment. Plans are visible, but purchase actions are unavailable."
      )
    ).toBeInTheDocument();
  });

  it("consumes paid deep links without auto-starting a plan change", async () => {
    const startPlanChange = vi.fn();
    mockUseOrganizationBilling.mockReturnValue(
      createBillingHookState({
        billingStatus: billingStatusFixture({
          plan: "team",
          effectivePlan: "team",
          source: "subscription",
          billingInterval: "monthly",
          subscriptionStatus: "active",
          hasCustomer: true,
          stripePriceId: "price_team",
        }),
        startPlanChange,
      })
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
        screen.queryByTestId("billing-deep-link-redirect")
      ).not.toBeInTheDocument();
    });
    expect(startPlanChange).not.toHaveBeenCalled();
    expect(screen.getAllByText(/\$38/).length).toBeGreaterThan(0);
  });

  it("consumes paid deep links before subscription status catches up", async () => {
    const startPlanChange = vi.fn();
    mockUseOrganizationBilling.mockReturnValue(
      createBillingHookState({
        billingStatus: billingStatusFixture({
          plan: "team",
          effectivePlan: "team",
          billingInterval: "monthly",
          subscriptionStatus: null,
          hasCustomer: true,
          stripePriceId: "price_team",
        }),
        startPlanChange,
      })
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
        screen.queryByTestId("billing-deep-link-redirect")
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
      })
    );

    const navigateBillingInSameTab = vi.fn();
    const onCheckoutIntentConsumed = vi.fn();

    renderAutoCheckoutTab({
      onCheckoutIntentConsumed,
      navigateBillingInSameTab,
    });

    await waitFor(() => {
      expect(startPlanChange).toHaveBeenCalledWith(
        expect.stringContaining("/organizations/org-1/billing"),
        "team",
        "annual",
        { confirmPaidPlanChange: false }
      );
    });
    await waitFor(() => {
      expect(onCheckoutIntentConsumed).toHaveBeenCalled();
    });
    await waitFor(() => {
      expect(
        screen.queryByTestId("billing-deep-link-redirect")
      ).not.toBeInTheDocument();
    });
    expect(navigateBillingInSameTab).not.toHaveBeenCalled();
  });

  it("opens the cadence-change portal flow from the billing current plan card", async () => {
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
      })
    );

    const openSpy = vi.spyOn(window, "open").mockImplementation(() => null);

    render(<OrganizationsTab organizationId="org-1" section="billing" />);

    fireEvent.click(screen.getByRole("button", { name: "Change to annual" }));

    await waitFor(() => {
      expect(openIntervalChangePortal).toHaveBeenCalledWith(
        expect.stringContaining("/organizations/org-1/billing"),
        "annual"
      );
    });
    expect(openPortal).not.toHaveBeenCalled();
    expect(openSpy).toHaveBeenCalledWith(
      "https://stripe.test/portal/interval",
      "_blank",
      "noopener,noreferrer"
    );
    openSpy.mockRestore();
  });

  it("opens the billing portal from the billing current plan card for paid owners", async () => {
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
      })
    );

    const openSpy = vi.spyOn(window, "open").mockImplementation(() => null);

    render(<OrganizationsTab organizationId="org-1" section="billing" />);

    fireEvent.click(screen.getByRole("button", { name: "Manage plan" }));

    await waitFor(() => {
      expect(openPortal).toHaveBeenCalledWith(
        expect.stringContaining("/organizations/org-1/billing")
      );
    });
    expect(openSpy).toHaveBeenCalledWith(
      "https://stripe.test/portal",
      "_blank",
      "noopener,noreferrer"
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
      })
    );

    render(<OrganizationsTab organizationId="org-1" section="billing" />);

    expect(
      screen.getByText(
        "Billing is not configured in this environment. Plans are visible, but purchase actions are unavailable."
      )
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
            scenarios: true,
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
      })
    );

    render(<OrganizationsTab organizationId="org-1" />);

    expect(
      screen.getByText("Audit Log requires Enterprise")
    ).toBeInTheDocument();
    expect(
      screen.queryByTestId("organization-audit-log")
    ).not.toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "View billing options" })
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
      })
    );

    render(<OrganizationsTab organizationId="org-1" />);

    expect(
      screen.queryByText("Loading audit log access...")
    ).not.toBeInTheDocument();
    expect(screen.getByTestId("organization-audit-log")).toBeInTheDocument();
  });

  it("calls onOrganizationDeleted and skips the fallback redirect when provided", async () => {
    window.history.replaceState({}, "", "/organizations/org-1");
    const onOrganizationDeleted = vi.fn();
    deleteOrganizationMock.mockResolvedValue(undefined);
    mockUseOrganizationBilling.mockReturnValue(
      createBillingHookState({
        billingStatus: billingStatusFixture({ plan: "free" }),
      })
    );

    render(
      <OrganizationsTab
        organizationId="org-1"
        onOrganizationDeleted={onOrganizationDeleted}
      />
    );

    fireEvent.click(
      screen.getByRole("button", { name: "Delete Organization" })
    );

    const dialog = await screen.findByRole("alertdialog");
    fireEvent.click(
      within(dialog).getByRole("button", { name: "Delete Organization" })
    );

    await waitFor(() => {
      expect(deleteOrganizationMock).toHaveBeenCalledWith({
        organizationId: "org-1",
      });
    });
    await waitFor(() => {
      expect(onOrganizationDeleted).toHaveBeenCalledWith("org-1");
    });

    expect(window.location.pathname).toBe("/organizations/org-1");
    expect(window.location.hash).toBe("");
  });
  /**
   * `?plans=open` is how the swarm limit dialog's "Explore MCPJam plans" link
   * gets the reader to the plans, which render below credits and payment
   * history — landing at the top of the page hides the thing they clicked for.
   */
  describe("plans deep link", () => {
    const withScrollSpy = () => {
      const scrollIntoView = vi.fn();
      const had = "scrollIntoView" in Element.prototype;
      const original = Element.prototype.scrollIntoView;
      Object.defineProperty(Element.prototype, "scrollIntoView", {
        configurable: true,
        value: scrollIntoView,
      });
      const restore = () => {
        if (had) {
          Object.defineProperty(Element.prototype, "scrollIntoView", {
            configurable: true,
            value: original,
          });
        } else {
          delete (Element.prototype as Partial<Element>).scrollIntoView;
        }
      };
      return { scrollIntoView, restore };
    };

    it("scrolls to Plans & Billing and consumes the flag", async () => {
      const { scrollIntoView, restore } = withScrollSpy();
      try {
        window.history.replaceState(
          null,
          "",
          "/organizations/org-1/billing?plans=open"
        );

        render(<OrganizationsTab organizationId="org-1" section="billing" />);

        await waitFor(() => expect(scrollIntoView).toHaveBeenCalled());
        // One-shot: a reload must not yank the page down again.
        expect(window.location.search).toBe("");
      } finally {
        restore();
      }
    });

    it("leaves the page where it is without the flag", async () => {
      const { scrollIntoView, restore } = withScrollSpy();
      try {
        window.history.replaceState(null, "", "/organizations/org-1/billing");

        render(<OrganizationsTab organizationId="org-1" section="billing" />);

        await screen.findByText("Plans & Billing");
        expect(scrollIntoView).not.toHaveBeenCalled();
      } finally {
        restore();
      }
    });

    it("waits for the billing flag to resolve before scrolling", async () => {
      const { scrollIntoView, restore } = withScrollSpy();
      try {
        // PostHog answers `undefined` until the flag loads, so the section the
        // link points at is not mounted on the first render. Scrolling then
        // would target nothing and the deep link would silently do nothing.
        mockUseFeatureFlagEnabled.mockImplementation((flag: string) =>
          flag === "billing-entitlements-ui" ? undefined : true
        );
        window.history.replaceState(
          null,
          "",
          "/organizations/org-1/billing?plans=open"
        );

        const view = render(
          <OrganizationsTab organizationId="org-1" section="billing" />
        );

        expect(screen.queryByText("Plans & Billing")).not.toBeInTheDocument();
        expect(scrollIntoView).not.toHaveBeenCalled();

        mockUseFeatureFlagEnabled.mockImplementation(() => true);
        view.rerender(
          <OrganizationsTab organizationId="org-1" section="billing" />
        );

        await waitFor(() => expect(scrollIntoView).toHaveBeenCalled());
      } finally {
        restore();
      }
    });
  });
});
