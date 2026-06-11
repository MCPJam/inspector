import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { OrganizationsTab } from "../OrganizationsTab";

const mockUseAuth = vi.fn();
const mockUseConvexAuth = vi.fn();
const mockUseOrganizationQueries = vi.fn();
const mockUseOrganizationMembers = vi.fn();
const mockUseOrganizationBilling = vi.fn();

const mockUpdateOrganization = vi.fn();
const mockDeleteOrganization = vi.fn();
const mockAddMember = vi.fn();
const mockChangeMemberRole = vi.fn();
const mockTransferOrganizationOwnership = vi.fn();
const mockRemoveMember = vi.fn();
const mockGenerateLogoUploadUrl = vi.fn();
const mockUpdateOrganizationLogo = vi.fn();

vi.mock("@workos-inc/authkit-react", () => ({
  useAuth: (...args: unknown[]) => mockUseAuth(...args),
}));

vi.mock("convex/react", () => ({
  useConvexAuth: (...args: unknown[]) => mockUseConvexAuth(...args),
}));

vi.mock("posthog-js/react", () => ({
  useFeatureFlagEnabled: () => false,
}));

vi.mock("@/hooks/useOrganizations", async () => {
  const actual = await vi.importActual<
    typeof import("@/hooks/useOrganizations")
  >("@/hooks/useOrganizations");

  return {
    ...actual,
    useOrganizationQueries: (...args: unknown[]) =>
      mockUseOrganizationQueries(...args),
    useOrganizationMembers: (...args: unknown[]) =>
      mockUseOrganizationMembers(...args),
    useOrganizationMutations: () => ({
      updateOrganization: mockUpdateOrganization,
      deleteOrganization: mockDeleteOrganization,
      addMember: mockAddMember,
      changeMemberRole: mockChangeMemberRole,
      transferOrganizationOwnership: mockTransferOrganizationOwnership,
      removeMember: mockRemoveMember,
      generateLogoUploadUrl: mockGenerateLogoUploadUrl,
      updateOrganizationLogo: mockUpdateOrganizationLogo,
    }),
  };
});

vi.mock("../organization/OrganizationAuditLog", () => ({
  OrganizationAuditLog: () => (
    <div data-testid="organization-audit-log">Audit Log</div>
  ),
}));

vi.mock("../organization/OrganizationMemberRow", () => ({
  OrganizationMemberRow: ({
    member,
    role,
    isPending,
    onRoleChange,
    onTransferOwnership,
    onRemove,
  }: any) => {
    const effectiveRole =
      role ?? member.role ?? (member.isOwner ? "owner" : "member");

    return (
      <div data-testid={`member-row-${member.email}`}>
        <span>{member.email}</span>
        <span>{effectiveRole}</span>
        {isPending ? <span>pending</span> : null}
        {onRoleChange ? (
          <button
            onClick={() =>
              onRoleChange(effectiveRole === "member" ? "admin" : "member")
            }
          >
            change-role-{member.email}
          </button>
        ) : null}
        {onTransferOwnership ? (
          <button onClick={onTransferOwnership}>transfer-{member.email}</button>
        ) : null}
        {onRemove ? (
          <button onClick={onRemove}>remove-{member.email}</button>
        ) : null}
      </div>
    );
  },
}));

vi.mock("sonner", () => ({
  toast: {
    success: vi.fn(),
    error: vi.fn(),
  },
}));

vi.mock("@/hooks/useOrganizationBilling", () => ({
  useOrganizationBilling: (...args: unknown[]) =>
    mockUseOrganizationBilling(...args),
  isPaidPlan: (plan: string) => plan !== "free",
}));

const organization = {
  _id: "org-1",
  name: "Acme Org",
  createdBy: "user-owner",
  createdAt: 1,
  updatedAt: 1,
  myRole: "owner" as const,
};

function createMember({
  email,
  role,
  isOwner = false,
  userId = "user-id",
}: {
  email: string;
  role: "owner" | "admin" | "member";
  isOwner?: boolean;
  userId?: string;
}) {
  return {
    _id: `member-${email}`,
    organizationId: "org-1",
    userId,
    email,
    role,
    isOwner,
    addedBy: "user-owner",
    addedAt: 1,
    user: {
      name: email,
      email,
      imageUrl: "",
    },
  };
}

describe("OrganizationsTab member management", () => {
  let currentUserEmail = "owner@example.com";
  let activeMembers = [
    createMember({ email: "owner@example.com", role: "owner", isOwner: true }),
    createMember({ email: "admin@example.com", role: "admin" }),
    createMember({ email: "member@example.com", role: "member" }),
  ];

  beforeEach(() => {
    vi.clearAllMocks();
    currentUserEmail = "owner@example.com";
    activeMembers = [
      createMember({
        email: "owner@example.com",
        role: "owner",
        isOwner: true,
      }),
      createMember({ email: "admin@example.com", role: "admin" }),
      createMember({ email: "member@example.com", role: "member" }),
    ];

    mockUseConvexAuth.mockReturnValue({ isAuthenticated: true });
    mockUseAuth.mockImplementation(() => ({
      user: { email: currentUserEmail },
      signIn: vi.fn(),
    }));
    mockUseOrganizationQueries.mockReturnValue({
      sortedOrganizations: [organization],
      isLoading: false,
    });
    mockUseOrganizationMembers.mockImplementation(() => ({
      activeMembers,
      pendingMembers: [],
      isLoading: false,
    }));
    mockUseOrganizationBilling.mockReturnValue({
      billingStatus: {
        organizationId: "org-1",
        organizationName: "Acme Org",
        plan: "free",
        effectivePlan: "free",
        source: "free",
        billingInterval: null,
        billingConfigured: true,
        subscriptionStatus: null,
        canManageBilling: true,
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
      },
      organizationPremiumness: undefined,
      activeSeatPaymentIntent: null,
      isLoadingBilling: false,
      isStartingPlanChange: false,
      pendingPlanChangeTarget: null,
      isOpeningPortal: false,
      isCancelingScheduledBillingChange: false,
      isFinishingSeatPayment: false,
      isCancelingSeatPayment: false,
      isHandlingSeatPayment: false,
      error: null,
      startPlanChange: vi.fn(),
      openPortal: vi.fn(),
      openIntervalChangePortal: vi.fn(),
      cancelScheduledBillingChange: vi.fn(),
      selectFreeAfterTrial: vi.fn(),
      finishSeatPayment: vi.fn(),
      cancelSeatPayment: vi.fn(),
    });

    mockUpdateOrganization.mockResolvedValue(undefined);
    mockDeleteOrganization.mockResolvedValue(undefined);
    mockAddMember.mockResolvedValue({ isPending: false });
    mockChangeMemberRole.mockResolvedValue({ success: true, changed: true });
    mockTransferOrganizationOwnership.mockResolvedValue({
      success: true,
      changed: true,
    });
    mockRemoveMember.mockResolvedValue({ success: true });
    mockGenerateLogoUploadUrl.mockResolvedValue("https://upload.example.com");
    mockUpdateOrganizationLogo.mockResolvedValue({ success: true });
  });

  it("shows members section for owners and allows role changes", async () => {
    render(<OrganizationsTab organizationId="org-1" />);

    expect(screen.getByText("Members")).toBeInTheDocument();
    expect(screen.getByPlaceholderText("Email address")).toHaveClass("sm:w-80");

    fireEvent.click(screen.getByText("change-role-member@example.com"));

    await waitFor(() => {
      expect(mockChangeMemberRole).toHaveBeenCalledWith({
        organizationId: "org-1",
        email: "member@example.com",
        role: "admin",
      });
    });
  });

  it("allows ownership transfer for owners", async () => {
    render(<OrganizationsTab organizationId="org-1" />);

    fireEvent.click(screen.getByText("transfer-member@example.com"));

    fireEvent.click(screen.getByRole("button", { name: "Transfer ownership" }));

    await waitFor(() => {
      expect(mockTransferOrganizationOwnership).toHaveBeenCalledWith({
        organizationId: "org-1",
        newOwnerEmail: "member@example.com",
      });
    });
  });

  it("shows members section for admins with read-only membership controls", () => {
    currentUserEmail = "admin@example.com";
    mockUseOrganizationQueries.mockReturnValue({
      sortedOrganizations: [{ ...organization, myRole: "admin" }],
      isLoading: false,
    });

    render(<OrganizationsTab organizationId="org-1" />);

    expect(screen.getByText("Members")).toBeInTheDocument();
    expect(
      screen.queryByText("change-role-member@example.com"),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByText("transfer-member@example.com"),
    ).not.toBeInTheDocument();
  });

  it("shows members section for non-admin members without admin controls", () => {
    currentUserEmail = "member@example.com";
    mockUseOrganizationQueries.mockReturnValue({
      sortedOrganizations: [{ ...organization, myRole: "member" }],
      isLoading: false,
    });
    mockUseOrganizationBilling.mockReturnValue({
      billingStatus: {
        organizationId: "org-1",
        organizationName: "Acme Org",
        plan: "free",
        effectivePlan: "free",
        source: "free",
        billingInterval: null,
        billingConfigured: true,
        subscriptionStatus: null,
        canManageBilling: false,
        isOwner: false,
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
      },
      organizationPremiumness: undefined,
      activeSeatPaymentIntent: null,
      isLoadingBilling: false,
      isStartingPlanChange: false,
      pendingPlanChangeTarget: null,
      isOpeningPortal: false,
      isCancelingScheduledBillingChange: false,
      isFinishingSeatPayment: false,
      isCancelingSeatPayment: false,
      isHandlingSeatPayment: false,
      error: null,
      startPlanChange: vi.fn(),
      openPortal: vi.fn(),
      openIntervalChangePortal: vi.fn(),
      cancelScheduledBillingChange: vi.fn(),
      selectFreeAfterTrial: vi.fn(),
      finishSeatPayment: vi.fn(),
      cancelSeatPayment: vi.fn(),
    });

    render(<OrganizationsTab organizationId="org-1" />);

    expect(screen.getByText("Access restricted")).toBeInTheDocument();
    expect(
      screen.getByText(
        "You don't have permission to view organization settings. Contact an admin or owner for access.",
      ),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "Go to Servers" }),
    ).toBeInTheDocument();
  });

  it("shows the sign-in prompt instead of mounting organization billing while Convex auth is unavailable", () => {
    const signIn = vi.fn();

    mockUseConvexAuth.mockReturnValue({
      isAuthenticated: false,
      isLoading: false,
    });
    mockUseAuth.mockReturnValue({
      user: { email: "owner@example.com" },
      signIn,
    });
    mockUseOrganizationQueries.mockReturnValue({
      sortedOrganizations: [organization],
      isLoading: false,
    });

    render(<OrganizationsTab organizationId="org-1" section="billing" />);

    expect(
      screen.getByText("Sign in to manage organizations"),
    ).toBeInTheDocument();
    expect(mockUseOrganizationBilling).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole("button", { name: "Sign In" }));
    expect(signIn).toHaveBeenCalledTimes(1);
  });

  it("shows pending seat payment only inside the members admin area", async () => {
    const finishSeatPayment = vi
      .fn()
      .mockResolvedValue({ status: "paid", seatQuantity: 4 });
    const cancelSeatPayment = vi.fn().mockResolvedValue(undefined);

    mockUseOrganizationBilling.mockReturnValue({
      billingStatus: {
        organizationId: "org-1",
        organizationName: "Acme Org",
        plan: "team",
        effectivePlan: "team",
        source: "subscription",
        billingInterval: "monthly",
        billingConfigured: true,
        subscriptionStatus: "active",
        canManageBilling: true,
        isOwner: true,
        hasCustomer: true,
        stripeScheduledPlan: null,
        stripeScheduledBillingInterval: null,
        stripeScheduledPriceId: null,
        stripeScheduledEffectiveAt: null,
        stripeCancelAtPeriodEnd: false,
        stripeCancelAt: null,
        stripeCanceledAt: null,
        stripeCurrentPeriodEnd: null,
        stripePriceId: "price_team_monthly",
        trialStatus: "none",
        trialPlan: null,
        trialStartedAt: null,
        trialEndsAt: null,
        trialDaysRemaining: null,
        decisionRequired: false,
        trialDecision: null,
      },
      organizationPremiumness: undefined,
      activeSeatPaymentIntent: {
        _id: "seat-payment-1",
        organizationId: "org-1",
        userId: "user-new",
        email: "new@example.com",
        role: "member",
        source: "organization",
        status: "requires_action",
        targetSeatQuantity: 4,
        stripeInvoiceId: "in_123",
        createdAt: 1,
        updatedAt: 2,
      },
      isLoadingBilling: false,
      isStartingPlanChange: false,
      pendingPlanChangeTarget: null,
      isOpeningPortal: false,
      isCancelingScheduledBillingChange: false,
      isHandlingSeatPayment: false,
      error: null,
      startPlanChange: vi.fn(),
      openPortal: vi.fn(),
      openIntervalChangePortal: vi.fn(),
      cancelScheduledBillingChange: vi.fn(),
      selectFreeAfterTrial: vi.fn(),
      finishSeatPayment,
      cancelSeatPayment,
    });

    render(<OrganizationsTab organizationId="org-1" />);

    expect(screen.getByTestId("pending-seat-payment-notice")).toHaveTextContent(
      "Finish payment to add new@example.com",
    );

    fireEvent.click(screen.getByRole("button", { name: "Finish payment" }));
    await waitFor(() =>
      expect(finishSeatPayment).toHaveBeenCalledWith(undefined),
    );

    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    await waitFor(() => expect(cancelSeatPayment).toHaveBeenCalledWith());
  });

  it("keeps pending seat cancel available while finish payment is loading", async () => {
    const cancelSeatPayment = vi.fn().mockResolvedValue(undefined);

    mockUseOrganizationBilling.mockReturnValue({
      billingStatus: {
        organizationId: "org-1",
        organizationName: "Acme Org",
        plan: "team",
        effectivePlan: "team",
        source: "subscription",
        billingInterval: "monthly",
        billingConfigured: true,
        subscriptionStatus: "active",
        canManageBilling: true,
        isOwner: true,
        hasCustomer: true,
        stripeScheduledPlan: null,
        stripeScheduledBillingInterval: null,
        stripeScheduledPriceId: null,
        stripeScheduledEffectiveAt: null,
        stripeCancelAtPeriodEnd: false,
        stripeCancelAt: null,
        stripeCanceledAt: null,
        stripeCurrentPeriodEnd: null,
        stripePriceId: "price_team_monthly",
        trialStatus: "none",
        trialPlan: null,
        trialStartedAt: null,
        trialEndsAt: null,
        trialDaysRemaining: null,
        decisionRequired: false,
        trialDecision: null,
      },
      organizationPremiumness: undefined,
      activeSeatPaymentIntent: {
        _id: "seat-payment-1",
        organizationId: "org-1",
        userId: "user-new",
        email: "new@example.com",
        role: "member",
        source: "organization",
        status: "requires_action",
        targetSeatQuantity: 4,
        stripeInvoiceId: "in_123",
        createdAt: 1,
        updatedAt: 2,
      },
      isLoadingBilling: false,
      isStartingPlanChange: false,
      pendingPlanChangeTarget: null,
      isOpeningPortal: false,
      isCancelingScheduledBillingChange: false,
      isFinishingSeatPayment: true,
      isCancelingSeatPayment: false,
      isHandlingSeatPayment: true,
      error: null,
      startPlanChange: vi.fn(),
      openPortal: vi.fn(),
      openIntervalChangePortal: vi.fn(),
      cancelScheduledBillingChange: vi.fn(),
      selectFreeAfterTrial: vi.fn(),
      finishSeatPayment: vi.fn(),
      cancelSeatPayment,
    });

    render(<OrganizationsTab organizationId="org-1" />);

    expect(screen.getByRole("button", { name: "Finish payment" })).toBeDisabled();
    const cancelButton = screen.getByRole("button", { name: "Cancel" });
    expect(cancelButton).toBeEnabled();

    fireEvent.click(cancelButton);
    await waitFor(() => expect(cancelSeatPayment).toHaveBeenCalledWith());
  });

  it("starts seat payment from the direct admin add-member action", async () => {
    const finishSeatPayment = vi
      .fn()
      .mockResolvedValue({ status: "paid", seatQuantity: 4 });
    mockAddMember.mockResolvedValue({
      needsSeatPayment: true,
      seatPaymentIntentId: "seat-payment-2",
    });
    mockUseOrganizationBilling.mockReturnValue({
      billingStatus: {
        organizationId: "org-1",
        organizationName: "Acme Org",
        plan: "team",
        effectivePlan: "team",
        source: "subscription",
        billingInterval: "monthly",
        billingConfigured: true,
        subscriptionStatus: "active",
        canManageBilling: true,
        isOwner: true,
        hasCustomer: true,
        stripeScheduledPlan: null,
        stripeScheduledBillingInterval: null,
        stripeScheduledPriceId: null,
        stripeScheduledEffectiveAt: null,
        stripeCancelAtPeriodEnd: false,
        stripeCancelAt: null,
        stripeCanceledAt: null,
        stripeCurrentPeriodEnd: null,
        stripePriceId: "price_team_monthly",
        trialStatus: "none",
        trialPlan: null,
        trialStartedAt: null,
        trialEndsAt: null,
        trialDaysRemaining: null,
        decisionRequired: false,
        trialDecision: null,
      },
      organizationPremiumness: undefined,
      activeSeatPaymentIntent: null,
      isLoadingBilling: false,
      isStartingPlanChange: false,
      pendingPlanChangeTarget: null,
      isOpeningPortal: false,
      isCancelingScheduledBillingChange: false,
      isHandlingSeatPayment: false,
      error: null,
      startPlanChange: vi.fn(),
      openPortal: vi.fn(),
      openIntervalChangePortal: vi.fn(),
      cancelScheduledBillingChange: vi.fn(),
      selectFreeAfterTrial: vi.fn(),
      finishSeatPayment,
      cancelSeatPayment: vi.fn(),
    });

    render(<OrganizationsTab organizationId="org-1" />);

    fireEvent.change(screen.getByPlaceholderText("Email address"), {
      target: { value: "new@example.com" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Add member" }));

    await waitFor(() => {
      expect(mockAddMember).toHaveBeenCalledWith({
        organizationId: "org-1",
        email: "new@example.com",
      });
    });
    await waitFor(() => {
      expect(finishSeatPayment).toHaveBeenCalledWith("seat-payment-2");
    });
  });
});
