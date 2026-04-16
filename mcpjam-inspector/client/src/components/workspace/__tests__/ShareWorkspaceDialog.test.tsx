import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { ShareWorkspaceDialog } from "../ShareWorkspaceDialog";

const mockCapture = vi.fn();
let mockBillingUiFlag = false;
const mockUseWorkspaceMembers = vi.fn();
const mockUseOrganizationBilling = vi.fn();
const mockResolveBillingGateState = vi.fn();
const mockCreateWorkspace = vi.fn();
const mockInviteWorkspaceMember = vi.fn();
const mockRemoveWorkspaceMember = vi.fn();
const mockUpdateWorkspaceMemberRole = vi.fn();
const mockUpdateWorkspaceInviteRole = vi.fn();
const mockToastSuccess = vi.fn();
const mockToastError = vi.fn();

vi.mock("posthog-js/react", () => ({
  usePostHog: () => ({
    capture: mockCapture,
  }),
  useFeatureFlagEnabled: (flag: string) =>
    flag === "billing-entitlements-ui" ? mockBillingUiFlag : false,
}));

vi.mock("convex/react", () => ({
  useConvexAuth: () => ({
    isAuthenticated: true,
  }),
  useQuery: () => undefined,
  useMutation: () => vi.fn(),
  useAction: () => vi.fn(),
}));

vi.mock("@/hooks/useProfilePicture", () => ({
  useProfilePicture: () => ({
    profilePictureUrl: null,
  }),
}));

vi.mock("sonner", () => ({
  toast: {
    success: (...args: unknown[]) => mockToastSuccess(...args),
    error: (...args: unknown[]) => mockToastError(...args),
  },
}));

vi.mock("@/hooks/useOrganizationBilling", () => ({
  useOrganizationBilling: (...args: unknown[]) =>
    mockUseOrganizationBilling(...args),
}));

vi.mock("@/lib/billing-gates", async () => {
  const actual =
    await vi.importActual<typeof import("@/lib/billing-gates")>(
      "@/lib/billing-gates",
    );

  return {
    ...actual,
    resolveBillingGateState: (...args: unknown[]) =>
      mockResolveBillingGateState(...args),
  };
});

vi.mock("@/hooks/useWorkspaces", async () => {
  const actual = await vi.importActual<typeof import("@/hooks/useWorkspaces")>(
    "@/hooks/useWorkspaces",
  );

  return {
    ...actual,
    useWorkspaceMembers: (...args: unknown[]) =>
      mockUseWorkspaceMembers(...args),
    useWorkspaceMutations: () => ({
      createWorkspace: mockCreateWorkspace,
      inviteWorkspaceMember: mockInviteWorkspaceMember,
      removeWorkspaceMember: mockRemoveWorkspaceMember,
      updateWorkspaceMemberRole: mockUpdateWorkspaceMemberRole,
      updateWorkspaceInviteRole: mockUpdateWorkspaceInviteRole,
    }),
  };
});

function createMember({
  email,
  role = "member",
  accessSource = "organization",
  canRemove = false,
  canChangeRole = false,
  workspaceRole,
  isPending = false,
}: {
  email: string;
  role?: "owner" | "admin" | "member" | "guest";
  accessSource?: "organization" | "workspace" | "invite";
  canRemove?: boolean;
  canChangeRole?: boolean;
  workspaceRole?: "admin" | "editor";
  isPending?: boolean;
}) {
  const isOrgPrivileged = role === "owner" || role === "admin";
  const resolvedWorkspaceRole =
    workspaceRole ?? (isOrgPrivileged ? "admin" : "editor");

  return {
    _id: `${isPending ? "pending" : "member"}-${email}`,
    workspaceId: "ws-1",
    organizationId: "org-1",
    userId: isPending ? undefined : `user-${email}`,
    email,
    role,
    workspaceRole: resolvedWorkspaceRole,
    canChangeRole,
    addedBy: "user-owner",
    addedAt: 1,
    revokedAt: undefined,
    isOwner: role === "owner",
    isPending,
    hasAccess: !isPending,
    accessSource,
    canRemove,
    user: isPending
      ? null
      : {
          name: email,
          email,
          imageUrl: "",
        },
  };
}

function renderDialog(
  overrides: Partial<React.ComponentProps<typeof ShareWorkspaceDialog>> = {},
) {
  const onClose = vi.fn();
  const onWorkspaceShared = vi.fn();

  const renderResult = render(
    <ShareWorkspaceDialog
      isOpen
      onClose={onClose}
      workspaceName="Acme"
      workspaceServers={{}}
      sharedWorkspaceId="ws-1"
      organizationId="org-1"
      visibility="public"
      currentUser={
        {
          email: "owner@example.com",
          firstName: "Owner",
          lastName: "Example",
        } as any
      }
      onWorkspaceShared={onWorkspaceShared}
      {...overrides}
    />,
  );

  return {
    ...renderResult,
    onClose,
    onWorkspaceShared,
  };
}

describe("ShareWorkspaceDialog", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    window.location.hash = "";
    mockBillingUiFlag = false;

    mockCreateWorkspace.mockResolvedValue("ws-created");
    mockInviteWorkspaceMember.mockResolvedValue({
      changed: true,
      kind: "workspace_invite_pending",
      isPending: true,
    });
    mockUseOrganizationBilling.mockReturnValue({
      billingStatus: null,
      organizationPremiumness: null,
      planCatalog: null,
      isLoadingBilling: false,
      isLoadingOrganizationPremiumness: false,
    });
    mockResolveBillingGateState.mockReturnValue({
      isDenied: false,
      isLoading: false,
      denialMessage: null,
      upgradePlan: null,
      organizationId: "org-1",
    });
    mockRemoveWorkspaceMember.mockResolvedValue({
      success: true,
      changed: true,
      removed: "workspace_access",
    });
    mockUseWorkspaceMembers.mockReturnValue({
      members: [
        createMember({
          email: "owner@example.com",
          role: "owner",
        }),
      ],
      activeMembers: [
        createMember({
          email: "owner@example.com",
          role: "owner",
        }),
      ],
      pendingMembers: [],
      canManageMembers: true,
      isLoading: false,
      hasPendingMembers: false,
    });
  });

  it("shows invite form on public workspace without description text", () => {
    renderDialog({
      visibility: "public",
    });

    // Description text and manage org button should be gone
    expect(
      screen.queryByText(/available to everyone in this organization/),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "Manage organization members" }),
    ).not.toBeInTheDocument();

    // Invite form should still be present
    expect(screen.getByRole("button", { name: "Invite" })).toBeInTheDocument();
  });

  it("shows private workspace with pending invites and role dropdowns", () => {
    mockUseWorkspaceMembers.mockReturnValue({
      members: [
        createMember({
          email: "owner@example.com",
          role: "owner",
        }),
        createMember({
          email: "member@example.com",
          role: "member",
          accessSource: "workspace",
          canRemove: true,
          canChangeRole: true,
        }),
        createMember({
          email: "pending@example.com",
          accessSource: "invite",
          canRemove: true,
          canChangeRole: true,
          isPending: true,
        }),
      ],
      activeMembers: [
        createMember({
          email: "owner@example.com",
          role: "owner",
        }),
        createMember({
          email: "member@example.com",
          role: "member",
          accessSource: "workspace",
          canRemove: true,
          canChangeRole: true,
        }),
      ],
      pendingMembers: [
        createMember({
          email: "pending@example.com",
          accessSource: "invite",
          canRemove: true,
          canChangeRole: true,
          isPending: true,
        }),
      ],
      canManageMembers: true,
      isLoading: false,
      hasPendingMembers: true,
    });

    renderDialog({
      visibility: "private",
    });

    // Description text should not be present
    expect(
      screen.queryByText(/Only invited organization members/),
    ).not.toBeInTheDocument();

    expect(screen.getByRole("button", { name: "Invite" })).toBeInTheDocument();
    expect(screen.getByText("Has access")).toBeInTheDocument();
    expect(screen.getByText("Invited")).toBeInTheDocument();

    // Org owner shows static "Admin" label (not changeable)
    // Members with canChangeRole show dropdown trigger with role label
    const editorButtons = screen.getAllByRole("button", { name: /Editor/ });
    expect(editorButtons.length).toBeGreaterThanOrEqual(1);
  });

  it("shows a read-only private dialog for non-admin members", () => {
    mockUseWorkspaceMembers.mockReturnValue({
      members: [
        createMember({
          email: "member@example.com",
          role: "member",
        }),
        createMember({
          email: "owner@example.com",
          role: "owner",
        }),
      ],
      activeMembers: [
        createMember({
          email: "member@example.com",
          role: "member",
        }),
        createMember({
          email: "owner@example.com",
          role: "owner",
        }),
      ],
      pendingMembers: [],
      canManageMembers: false,
      isLoading: false,
      hasPendingMembers: false,
    });

    renderDialog({
      visibility: "private",
      currentUser: {
        email: "member@example.com",
        firstName: "Member",
        lastName: "Example",
      } as any,
    });

    expect(
      screen.getByText("Only workspace admins can invite people."),
    ).toBeInTheDocument();
    expect(screen.queryByText("Invite with email")).not.toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "Invite" }),
    ).not.toBeInTheDocument();
  });

  it("creates the workspace before inviting on the first share flow", async () => {
    const { onWorkspaceShared } = renderDialog({
      sharedWorkspaceId: null,
      visibility: "private",
    });

    fireEvent.change(screen.getByPlaceholderText("Add people, emails..."), {
      target: { value: "invitee@example.com" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Invite" }));

    await waitFor(() => {
      expect(mockCreateWorkspace).toHaveBeenCalledWith({
        organizationId: "org-1",
        name: "Acme",
        servers: {},
        visibility: "private",
      });
    });
    expect(onWorkspaceShared).toHaveBeenCalledWith("ws-created");
    expect(mockInviteWorkspaceMember).toHaveBeenCalledWith({
      workspaceId: "ws-created",
      email: "invitee@example.com",
      role: "editor",
    });
    expect(mockToastSuccess).toHaveBeenCalledWith(
      "Invitation sent to invitee@example.com. They'll get workspace access once they join the organization.",
    );
  });

  it("shows a workspace picker only when multiple workspaces are available", () => {
    renderDialog({
      availableWorkspaces: {
        "workspace-a": {
          id: "workspace-a",
          name: "Acme",
          servers: {},
          createdAt: new Date(),
          updatedAt: new Date(),
          sharedWorkspaceId: "ws-1",
          organizationId: "org-1",
          visibility: "public",
        },
      },
      activeWorkspaceId: "workspace-a",
    });

    expect(
      screen.queryByRole("button", { name: "Select workspace" }),
    ).not.toBeInTheDocument();
  });

  it("lets multi-workspace users switch invite targets inside the dialog", async () => {
    mockUseWorkspaceMembers.mockImplementation(
      ({ workspaceId }: { workspaceId: string | null }) => {
        const memberEmail =
          workspaceId === "ws-2"
            ? "beta-member@example.com"
            : "alpha-member@example.com";

        return {
          members: [
            createMember({
              email: "owner@example.com",
              role: "owner",
            }),
            createMember({
              email: memberEmail,
              role: "member",
            }),
          ],
          activeMembers: [
            createMember({
              email: "owner@example.com",
              role: "owner",
            }),
            createMember({
              email: memberEmail,
              role: "member",
            }),
          ],
          pendingMembers: [],
          canManageMembers: true,
          isLoading: false,
          hasPendingMembers: false,
        };
      },
    );

    renderDialog({
      availableWorkspaces: {
        "workspace-a": {
          id: "workspace-a",
          name: "Acme",
          servers: {},
          createdAt: new Date(),
          updatedAt: new Date(),
          sharedWorkspaceId: "ws-1",
          organizationId: "org-1",
          visibility: "public",
        },
        "workspace-b": {
          id: "workspace-b",
          name: "Beta",
          servers: {},
          createdAt: new Date(),
          updatedAt: new Date(),
          sharedWorkspaceId: "ws-2",
          organizationId: "org-1",
          visibility: "private",
        },
        "workspace-c": {
          id: "workspace-c",
          name: "Gamma",
          servers: {},
          createdAt: new Date(),
          updatedAt: new Date(),
          sharedWorkspaceId: "ws-3",
          organizationId: "org-1",
          visibility: "public",
        },
      },
      activeWorkspaceId: "workspace-a",
    });

    expect(
      screen.getByRole("heading", { name: 'Share "Acme" Workspace' }),
    ).toBeInTheDocument();
    expect(
      screen.getAllByText("alpha-member@example.com").length,
    ).toBeGreaterThan(0);

    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: "Select workspace" }));
    await user.click(screen.getByRole("menuitemradio", { name: /Beta/ }));

    expect(
      screen.getByRole("heading", { name: 'Share "Beta" Workspace' }),
    ).toBeInTheDocument();
    expect(
      screen.getAllByText("beta-member@example.com").length,
    ).toBeGreaterThan(0);
    expect(screen.getByText("Private to members")).toBeInTheDocument();
    expect(screen.queryAllByText("alpha-member@example.com")).toHaveLength(0);
  });

  it("keeps the chosen workspace selected when workspaces refresh while open", async () => {
    const currentUser = {
      email: "owner@example.com",
      firstName: "Owner",
      lastName: "Example",
    } as any;
    const availableWorkspaces = {
      "workspace-a": {
        id: "workspace-a",
        name: "Acme",
        servers: {},
        createdAt: new Date("2026-04-01T00:00:00Z"),
        updatedAt: new Date("2026-04-01T00:00:00Z"),
        sharedWorkspaceId: "ws-1",
        organizationId: "org-1",
        visibility: "public" as const,
      },
      "workspace-b": {
        id: "workspace-b",
        name: "Beta",
        servers: {},
        createdAt: new Date("2026-04-02T00:00:00Z"),
        updatedAt: new Date("2026-04-02T00:00:00Z"),
        sharedWorkspaceId: "ws-2",
        organizationId: "org-1",
        visibility: "private" as const,
      },
    };

    const { rerender } = render(
      <ShareWorkspaceDialog
        isOpen
        onClose={vi.fn()}
        workspaceName="Acme"
        workspaceServers={{}}
        sharedWorkspaceId="ws-1"
        organizationId="org-1"
        visibility="public"
        currentUser={currentUser}
        onWorkspaceShared={vi.fn()}
        availableWorkspaces={availableWorkspaces}
        activeWorkspaceId="workspace-a"
      />,
    );

    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: "Select workspace" }));
    await user.click(screen.getByRole("menuitemradio", { name: /Beta/ }));

    expect(
      screen.getByRole("heading", { name: 'Share "Beta" Workspace' }),
    ).toBeInTheDocument();

    rerender(
      <ShareWorkspaceDialog
        isOpen
        onClose={vi.fn()}
        workspaceName="Acme"
        workspaceServers={{}}
        sharedWorkspaceId="ws-1"
        organizationId="org-1"
        visibility="public"
        currentUser={currentUser}
        onWorkspaceShared={vi.fn()}
        availableWorkspaces={{
          "workspace-a": {
            ...availableWorkspaces["workspace-a"],
            updatedAt: new Date("2026-04-03T00:00:00Z"),
          },
          "workspace-b": {
            ...availableWorkspaces["workspace-b"],
            updatedAt: new Date("2026-04-04T00:00:00Z"),
          },
        }}
        activeWorkspaceId="workspace-a"
      />,
    );

    expect(
      screen.getByRole("heading", { name: 'Share "Beta" Workspace' }),
    ).toBeInTheDocument();
  });

  it("creates and shares the selected workspace when inviting from the picker", async () => {
    const { onWorkspaceShared } = renderDialog({
      availableWorkspaces: {
        "workspace-a": {
          id: "workspace-a",
          name: "Acme",
          servers: {},
          createdAt: new Date(),
          updatedAt: new Date(),
          sharedWorkspaceId: "ws-1",
          organizationId: "org-1",
          visibility: "public",
        },
        "workspace-b": {
          id: "workspace-b",
          name: "Beta",
          servers: {
            "beta-server": {
              name: "Beta Server",
            } as any,
          },
          createdAt: new Date(),
          updatedAt: new Date(),
          organizationId: "org-1",
          visibility: "private",
        },
      },
      activeWorkspaceId: "workspace-a",
    });

    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: "Select workspace" }));
    await user.click(screen.getByRole("menuitemradio", { name: /Beta/ }));

    fireEvent.change(screen.getByPlaceholderText("Add people, emails..."), {
      target: { value: "invitee@example.com" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Invite" }));

    await waitFor(() => {
      expect(mockCreateWorkspace).toHaveBeenCalledWith(
        expect.objectContaining({
          organizationId: "org-1",
          name: "Beta",
          visibility: "private",
        }),
      );
    });
    expect(onWorkspaceShared).toHaveBeenCalledWith("ws-created", "workspace-b");
    expect(mockInviteWorkspaceMember).toHaveBeenCalledWith({
      workspaceId: "ws-created",
      email: "invitee@example.com",
      role: "editor",
    });
  });

  it("disables Invite and shows inline validation for invalid emails", () => {
    renderDialog();

    fireEvent.change(screen.getByPlaceholderText("Add people, emails..."), {
      target: { value: "not-an-email" },
    });

    expect(
      screen.getByText("Enter a valid email address."),
    ).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Invite" })).toBeDisabled();
  });

  it("shows the member limit upsell and re-enables Invite when the gate clears", () => {
    mockBillingUiFlag = true;
    mockUseOrganizationBilling.mockReturnValue({
      billingStatus: {
        canManageBilling: true,
      },
      organizationPremiumness: null,
      planCatalog: null,
      isLoadingBilling: false,
      isLoadingOrganizationPremiumness: false,
    });
    mockResolveBillingGateState.mockReturnValue({
      isDenied: true,
      isLoading: false,
      denialMessage: "Member limit reached",
      upgradePlan: "pro",
      organizationId: "org-1",
    });

    const { rerender } = renderDialog();

    fireEvent.change(screen.getByPlaceholderText("Add people, emails..."), {
      target: { value: "invitee@example.com" },
    });

    expect(screen.getByTestId("member-limit-upsell")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Invite" })).toBeDisabled();

    mockResolveBillingGateState.mockReturnValue({
      isDenied: false,
      isLoading: false,
      denialMessage: null,
      upgradePlan: null,
      organizationId: "org-1",
    });

    rerender(
      <ShareWorkspaceDialog
        isOpen
        onClose={vi.fn()}
        workspaceName="Acme"
        workspaceServers={{}}
        sharedWorkspaceId="ws-1"
        organizationId="org-1"
        visibility="public"
        currentUser={
          {
            email: "owner@example.com",
            firstName: "Owner",
            lastName: "Example",
          } as any
        }
        onWorkspaceShared={vi.fn()}
      />,
    );

    expect(
      screen.queryByTestId("member-limit-upsell"),
    ).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Invite" })).toBeEnabled();
  });

  it("calls the workspace-scoped removal mutation via role dropdown", async () => {
    mockUseWorkspaceMembers.mockReturnValue({
      members: [
        createMember({
          email: "owner@example.com",
          role: "owner",
        }),
        createMember({
          email: "member@example.com",
          role: "member",
          accessSource: "workspace",
          canRemove: true,
          canChangeRole: true,
        }),
      ],
      activeMembers: [
        createMember({
          email: "owner@example.com",
          role: "owner",
        }),
        createMember({
          email: "member@example.com",
          role: "member",
          accessSource: "workspace",
          canRemove: true,
          canChangeRole: true,
        }),
      ],
      pendingMembers: [],
      canManageMembers: true,
      isLoading: false,
      hasPendingMembers: false,
    });

    renderDialog({
      visibility: "private",
    });

    // Open the role dropdown for the member (second Editor button; first is the invite role picker)
    const user = userEvent.setup();
    const editorButtons = screen.getAllByRole("button", { name: /Editor/ });
    await user.click(editorButtons[editorButtons.length - 1]);

    // Click "Remove from workspace" in the dropdown
    const removeItem = await screen.findByText("Remove from workspace");
    await user.click(removeItem);

    await waitFor(() => {
      expect(mockRemoveWorkspaceMember).toHaveBeenCalledWith({
        workspaceId: "ws-1",
        email: "member@example.com",
      });
    });
    expect(mockToastSuccess).toHaveBeenCalledWith("Workspace access removed");
  });
});
