import { describe, expect, it, beforeEach, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import { OrganizationsTab } from "../OrganizationsTab";
import { useOrganizationBilling } from "@/hooks/useOrganizationBilling";

const mockUseAuth = vi.fn();
const mockUseConvexAuth = vi.fn();
const mockUseOrganizationQueries = vi.fn();
const mockUseOrganizationMembers = vi.fn();
const mockUseOrganizationBilling = vi.mocked(useOrganizationBilling);

vi.mock("@workos-inc/authkit-react", () => ({
  useAuth: (...args: unknown[]) => mockUseAuth(...args),
}));

vi.mock("convex/react", () => ({
  useConvexAuth: (...args: unknown[]) => mockUseConvexAuth(...args),
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

  it("shows Upgrade CTA for OSS plan", () => {
    mockUseOrganizationBilling.mockReturnValue({
      billingStatus: {
        organizationId: "org-1",
        organizationName: "Org One",
        plan: "oss",
        subscriptionStatus: null,
        canManageBilling: true,
        isOwner: true,
        hasCustomer: false,
        stripeCurrentPeriodEnd: null,
        stripePriceId: null,
      },
      isLoadingBilling: false,
      isStartingCheckout: false,
      isOpeningPortal: false,
      error: null,
      startCheckout: vi.fn(),
      openPortal: vi.fn(),
    });

    render(<OrganizationsTab organizationId="org-1" />);

    expect(screen.getByText("Billing")).toBeInTheDocument();
    expect(screen.getByText("Subscription status")).toBeInTheDocument();
    expect(screen.getByText("Not subscribed")).toBeInTheDocument();
    expect(screen.getByText("Current period ends")).toBeInTheDocument();
    expect(screen.getByText("Not available")).toBeInTheDocument();
    expect(screen.getByText("Billing account")).toBeInTheDocument();
    expect(screen.getByText("Not connected")).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "Upgrade to MCPJam Pro" }),
    ).toBeInTheDocument();
  });

  it("shows Manage subscription CTA for Pro plan", () => {
    const periodEnd = 1_705_000_000_000;
    const formattedPeriodEnd = new Intl.DateTimeFormat(undefined, {
      month: "short",
      day: "numeric",
      year: "numeric",
    }).format(new Date(periodEnd));

    mockUseOrganizationBilling.mockReturnValue({
      billingStatus: {
        organizationId: "org-1",
        organizationName: "Org One",
        plan: "pro",
        subscriptionStatus: "active",
        canManageBilling: true,
        isOwner: true,
        hasCustomer: true,
        stripeCurrentPeriodEnd: periodEnd,
        stripePriceId: "price_123",
      },
      isLoadingBilling: false,
      isStartingCheckout: false,
      isOpeningPortal: false,
      error: null,
      startCheckout: vi.fn(),
      openPortal: vi.fn(),
    });

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
          userId: "user-member",
          email: "member@example.com",
          role: "member",
          isOwner: false,
          addedBy: "user-owner",
          addedAt: 1,
          user: {
            name: "Member",
            email: "member@example.com",
            imageUrl: "",
          },
        },
      ],
      pendingMembers: [],
      isLoading: false,
    });
    mockUseAuth.mockReturnValue({
      user: { email: "member@example.com" },
      signIn: vi.fn(),
    });

    mockUseOrganizationBilling.mockReturnValue({
      billingStatus: {
        organizationId: "org-1",
        organizationName: "Org One",
        plan: "oss",
        subscriptionStatus: null,
        canManageBilling: false,
        isOwner: false,
        hasCustomer: false,
        stripeCurrentPeriodEnd: null,
        stripePriceId: null,
      },
      isLoadingBilling: false,
      isStartingCheckout: false,
      isOpeningPortal: false,
      error: null,
      startCheckout: vi.fn(),
      openPortal: vi.fn(),
    });

    render(<OrganizationsTab organizationId="org-1" />);

    expect(
      screen.getByRole("button", { name: "Upgrade to MCPJam Pro" }),
    ).toBeDisabled();
    expect(
      screen.getByText("Only organization owners can manage billing."),
    ).toBeInTheDocument();
  });
});
