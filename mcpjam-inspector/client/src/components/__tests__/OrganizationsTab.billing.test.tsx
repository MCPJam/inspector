import { describe, expect, it, beforeEach, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import { OrganizationsTab } from "../OrganizationsTab";
import { useOrganizationBilling } from "@/hooks/useOrganizationBilling";

const mockUseAuth = vi.fn();
const mockUseConvexAuth = vi.fn();
const mockUseOrganizationQueries = vi.fn();
const mockUseOrganizationMembers = vi.fn();
const mockUseFeatureFlagEnabled = vi.fn();
const mockUseOrganizationBilling = vi.mocked(useOrganizationBilling);

function createBillingHookState(overrides: Record<string, unknown>) {
  return {
    billingStatus: undefined,
    entitlements: undefined,
    rolloutState: undefined,
    isLoadingBilling: false,
    isLoadingEntitlements: false,
    isLoadingRollout: false,
    isStartingCheckout: false,
    isOpeningPortal: false,
    error: null,
    startCheckout: vi.fn(),
    openPortal: vi.fn(),
    ...overrides,
  };
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

vi.mock("@/hooks/useOrganizations", () => ({
  useOrganizationQueries: (...args: unknown[]) =>
    mockUseOrganizationQueries(...args),
  useOrganizationMembers: (...args: unknown[]) =>
    mockUseOrganizationMembers(...args),
  useOrganizationMutations: () => ({
    updateOrganization: vi.fn(),
    deleteOrganization: vi.fn(),
    addMember: vi.fn(),
    changeMemberRole: vi.fn(),
    transferOrganizationOwnership: vi.fn(),
    removeMember: vi.fn(),
    generateLogoUploadUrl: vi.fn(),
    updateOrganizationLogo: vi.fn(),
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

    mockUseConvexAuth.mockReturnValue({ isAuthenticated: true });
    mockUseFeatureFlagEnabled.mockReturnValue(true);
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

  it("shows Upgrade CTA for free plan", () => {
    mockUseOrganizationBilling.mockReturnValue(
      createBillingHookState({
        billingStatus: {
          organizationId: "org-1",
          organizationName: "Org One",
          plan: "free",
          billingInterval: null,
          billingConfigured: true,
          subscriptionStatus: null,
          canManageBilling: true,
          isOwner: true,
          hasCustomer: false,
          stripeCurrentPeriodEnd: null,
          stripePriceId: null,
        },
      }),
    );

    render(<OrganizationsTab organizationId="org-1" />);

    expect(screen.getByText("Billing")).toBeInTheDocument();
    expect(screen.getByText("Subscription status")).toBeInTheDocument();
    expect(screen.getByText("Not subscribed")).toBeInTheDocument();
    expect(screen.getByText("Current period ends")).toBeInTheDocument();
    expect(screen.getByText("Not available")).toBeInTheDocument();
    expect(screen.getByText("Billing account")).toBeInTheDocument();
    expect(screen.getByText("Not connected")).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "Upgrade plan" }),
    ).toBeInTheDocument();
  });

  it("shows Manage subscription CTA for starter plan", () => {
    const periodEnd = 1_705_000_000_000;
    const formattedPeriodEnd = new Intl.DateTimeFormat(undefined, {
      month: "short",
      day: "numeric",
      year: "numeric",
    }).format(new Date(periodEnd));

    mockUseOrganizationBilling.mockReturnValue(
      createBillingHookState({
        billingStatus: {
          organizationId: "org-1",
          organizationName: "Org One",
          plan: "starter",
          billingInterval: "monthly",
          billingConfigured: true,
          subscriptionStatus: "active",
          canManageBilling: true,
          isOwner: true,
          hasCustomer: true,
          stripeCurrentPeriodEnd: periodEnd,
          stripePriceId: "price_123",
        },
      }),
    );

    render(<OrganizationsTab organizationId="org-1" />);

    expect(screen.getByText("Subscription status")).toBeInTheDocument();
    expect(screen.getByText("active")).toBeInTheDocument();
    expect(screen.getByText("Billing account")).toBeInTheDocument();
    expect(screen.getByText("Connected")).toBeInTheDocument();
    expect(screen.getByText(formattedPeriodEnd)).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "Manage subscription" }),
    ).toBeInTheDocument();
  });

  it("disables billing action for non-owners", () => {
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
        billingStatus: {
          organizationId: "org-1",
          organizationName: "Org One",
          plan: "free",
          billingInterval: null,
          billingConfigured: true,
          subscriptionStatus: null,
          canManageBilling: false,
          isOwner: false,
          hasCustomer: false,
          stripeCurrentPeriodEnd: null,
          stripePriceId: null,
        },
      }),
    );

    render(<OrganizationsTab organizationId="org-1" />);

    expect(screen.getByRole("button", { name: "Upgrade plan" })).toBeDisabled();
    expect(
      screen.getByText("Only organization owners can manage billing."),
    ).toBeInTheDocument();
  });

  it("locks audit log behind enterprise after enforcement becomes active", () => {
    mockUseOrganizationBilling.mockReturnValue(
      createBillingHookState({
        billingStatus: {
          organizationId: "org-1",
          organizationName: "Org One",
          plan: "team",
          billingInterval: "monthly",
          billingConfigured: true,
          subscriptionStatus: "active",
          canManageBilling: true,
          isOwner: true,
          hasCustomer: true,
          stripeCurrentPeriodEnd: null,
          stripePriceId: "price_123",
        },
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
        rolloutState: {
          enforcementConfigured: true,
          gracePeriodEndsAt: "2026-04-04T00:00:00.000Z",
          enforcementActive: true,
        },
        isLoadingBilling: false,
        isLoadingEntitlements: false,
        isLoadingRollout: false,
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
        billingStatus: {
          organizationId: "org-1",
          organizationName: "Org One",
          plan: "team",
          billingInterval: "monthly",
          billingConfigured: true,
          subscriptionStatus: "active",
          canManageBilling: true,
          isOwner: true,
          hasCustomer: true,
          stripeCurrentPeriodEnd: null,
          stripePriceId: "price_123",
        },
        isLoadingEntitlements: true,
        isLoadingRollout: true,
      }),
    );

    render(<OrganizationsTab organizationId="org-1" />);

    expect(
      screen.queryByText("Loading audit log access..."),
    ).not.toBeInTheDocument();
    expect(screen.getByTestId("organization-audit-log")).toBeInTheDocument();
  });
});
