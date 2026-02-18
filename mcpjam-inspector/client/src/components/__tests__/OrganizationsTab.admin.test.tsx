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
}));

const organization = {
  _id: "org-1",
  name: "Acme Org",
  createdBy: "user-owner",
  createdAt: 1,
  updatedAt: 1,
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
    mockUseOrganizationBilling.mockReturnValue({
      billingStatus: {
        organizationId: "org-1",
        organizationName: "Acme Org",
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

    expect(screen.queryByText("Admin Console")).not.toBeInTheDocument();
    expect(
      screen.queryByTestId("organization-audit-log"),
    ).not.toBeInTheDocument();
    expect(screen.getByText("Members")).toBeInTheDocument();
    expect(
      screen.getByText("Only organization owners can manage billing."),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "Upgrade to MCPJam Pro" }),
    ).toBeDisabled();
    expect(
      screen.queryByText("change-role-member@example.com"),
    ).not.toBeInTheDocument();
  });
});
