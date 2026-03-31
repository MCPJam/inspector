import { useState } from "react";
import { describe, expect, it, beforeEach, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
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
    plans: {
      free: {
        plan: "free",
        displayName: "Free",
        isSelfServe: false,
        prices: { monthly: null, annual: null },
        features: {
          evals: false,
          sandboxes: false,
          cicd: false,
          customDomains: false,
          auditLog: false,
          sso: false,
          prioritySupport: false,
        },
        limits: {
          maxMembers: 1,
          maxWorkspaces: null,
          maxServersPerWorkspace: 0,
          maxSandboxesPerWorkspace: 0,
          maxEvalRunsPerMonth: 5,
        },
        auditLogRetentionLabel: "Not included",
      },
      starter: {
        plan: "starter",
        displayName: "Starter",
        isSelfServe: true,
        prices: { monthly: 6100, annual: 58800 },
        features: {
          evals: true,
          sandboxes: true,
          cicd: true,
          customDomains: false,
          auditLog: false,
          sso: false,
          prioritySupport: false,
        },
        limits: {
          maxMembers: 3,
          maxWorkspaces: null,
          maxServersPerWorkspace: 10,
          maxSandboxesPerWorkspace: 1,
          maxEvalRunsPerMonth: 500,
        },
        auditLogRetentionLabel: "Not included",
      },
      team: {
        plan: "team",
        displayName: "Team",
        isSelfServe: true,
        prices: { monthly: 7400, annual: 70800 },
        features: {
          evals: true,
          sandboxes: true,
          cicd: true,
          customDomains: true,
          auditLog: false,
          sso: true,
          prioritySupport: true,
        },
        limits: {
          maxMembers: null,
          maxWorkspaces: null,
          maxServersPerWorkspace: 50,
          maxSandboxesPerWorkspace: 5,
          maxEvalRunsPerMonth: 5000,
        },
        auditLogRetentionLabel: "Not included",
      },
      enterprise: {
        plan: "enterprise",
        displayName: "Enterprise",
        isSelfServe: false,
        prices: { monthly: null, annual: null },
        features: {
          evals: true,
          sandboxes: true,
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
          maxSandboxesPerWorkspace: null,
          maxEvalRunsPerMonth: null,
        },
        auditLogRetentionLabel: "Included",
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
    source: "persisted",
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
    isStartingCheckout: false,
    isOpeningPortal: false,
    isSelectingFreeAfterTrial: false,
    error: null,
    startCheckout: vi.fn(),
    openPortal: vi.fn(),
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

    expect(
      screen.getByRole("button", { name: "Billing" }),
    ).toBeInTheDocument();
    expect(screen.getByText("Billing cycle")).toBeInTheDocument();
    expect(screen.queryByText("Subscription status")).not.toBeInTheDocument();
    expect(screen.getByTestId("current-plan-renewal")).toHaveTextContent(
      "No active subscription",
    );
    expect(
      screen.getByRole("button", { name: "View plans" }),
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
    expect(
      screen.getAllByRole("button", { name: "Upgrade" }),
    ).toHaveLength(1);
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
    const startCheckout = vi
      .fn()
      .mockResolvedValue("https://stripe.test/checkout");
    mockUseOrganizationBilling.mockReturnValue(
      createBillingHookState({
        billingStatus: billingStatusFixture(),
        startCheckout,
      }),
    );

    const openSpy = vi.spyOn(window, "open").mockImplementation(() => null);

    render(<OrganizationsTab organizationId="org-1" section="billing" />);

    const upgradeButtons = screen.getAllByRole("button", { name: "Upgrade" });
    fireEvent.click(upgradeButtons[0]!);

    await waitFor(() => {
      expect(startCheckout).toHaveBeenCalledWith(
        expect.stringContaining("#organizations/org-1/billing"),
        "starter",
        "monthly",
      );
    });
    expect(openSpy).toHaveBeenCalledWith(
      "https://stripe.test/checkout",
      "_blank",
      "noopener,noreferrer",
    );
    openSpy.mockRestore();
  });

  it("auto-checks out billing deep links in the same tab", async () => {
    const startCheckout = vi
      .fn()
      .mockResolvedValue("https://stripe.test/checkout");
    mockUseOrganizationBilling.mockReturnValue(
      createBillingHookState({
        billingStatus: billingStatusFixture(),
        startCheckout,
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
      expect(startCheckout).toHaveBeenCalledWith(
        expect.stringContaining("#organizations/org-1/billing"),
        "starter",
        "annual",
      );
    });
    expect(onCheckoutIntentNavigationStarted).toHaveBeenCalled();
    expect(onCheckoutIntentConsumed).not.toHaveBeenCalled();
    expect(navigateBillingInSameTab).toHaveBeenCalledWith(
      "https://stripe.test/checkout",
    );
    expect(openSpy).not.toHaveBeenCalled();
    expect(screen.getByTestId("billing-deep-link-redirect")).toBeInTheDocument();

    openSpy.mockRestore();
  });

  it("consumes billing deep-link checkout intent when billing is unavailable", async () => {
    const startCheckout = vi.fn();
    mockUseOrganizationBilling.mockReturnValue(
      createBillingHookState({
        billingStatus: billingStatusFixture({
          billingConfigured: false,
          canManageBilling: false,
        }),
        startCheckout,
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
    expect(startCheckout).not.toHaveBeenCalled();
    expect(
      screen.getByText(
        "Billing is not configured in this environment. Plans are visible, but purchase actions are unavailable.",
      ),
    ).toBeInTheDocument();
  });

  it("consumes billing deep-link checkout intent and shows the existing notice for lower-plan links", async () => {
    const startCheckout = vi.fn();
    mockUseOrganizationBilling.mockReturnValue(
      createBillingHookState({
        billingStatus: billingStatusFixture({
          plan: "team",
          effectivePlan: "team",
          billingInterval: "annual",
          subscriptionStatus: "active",
          hasCustomer: true,
          stripePriceId: "price_team",
        }),
        startCheckout,
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
    expect(startCheckout).not.toHaveBeenCalled();
    expect(
      screen.getByText("You’re already on a higher plan"),
    ).toBeInTheDocument();
  });

  it("consumes billing deep-link checkout intent when auto-checkout startup fails", async () => {
    const startCheckout = vi
      .fn()
      .mockRejectedValue(new Error("Failed to start checkout flow"));
    mockUseOrganizationBilling.mockReturnValue(
      createBillingHookState({
        billingStatus: billingStatusFixture(),
        startCheckout,
      }),
    );

    const navigateBillingInSameTab = vi.fn();
    const onCheckoutIntentConsumed = vi.fn();

    renderAutoCheckoutTab({
      onCheckoutIntentConsumed,
      navigateBillingInSameTab,
    });

    await waitFor(() => {
      expect(startCheckout).toHaveBeenCalledWith(
        expect.stringContaining("#organizations/org-1/billing"),
        "starter",
        "annual",
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
          source: "persisted",
          features: {
            evals: true,
            sandboxes: true,
            cicd: true,
            customDomains: true,
            auditLog: false,
            sso: false,
            prioritySupport: true,
          },
          limits: {},
        },
        organizationPremiumness: {
          enforcementState: "enabled",
          effectivePlan: "team",
          gates: {
            auditLog: {
              allowed: false,
              gateKey: "auditLog",
              upgradePlan: "enterprise",
            },
          },
        },
        isLoadingBilling: false,
        isLoadingEntitlements: false,
        isLoadingOrganizationPremiumness: false,
        isStartingCheckout: false,
        isOpeningPortal: false,
        error: null,
        startCheckout: vi.fn(),
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
});
