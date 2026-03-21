import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { ShareWorkspaceDialog } from "../ShareWorkspaceDialog";

const mockCapture = vi.fn();
const mockUseWorkspaceMembers = vi.fn();
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
}));

vi.mock("convex/react", () => ({
  useConvexAuth: () => ({
    isAuthenticated: true,
  }),
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

  render(
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
    onClose,
    onWorkspaceShared,
  };
}

describe("ShareWorkspaceDialog", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    window.location.hash = "";

    mockCreateWorkspace.mockResolvedValue("ws-created");
    mockInviteWorkspaceMember.mockResolvedValue({
      changed: true,
      kind: "workspace_invite_pending",
      isPending: true,
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

  it("shows public workspace copy and manage-organization affordance", () => {
    const { onClose } = renderDialog({
      visibility: "public",
    });

    expect(
      screen.getByText(
        "This workspace is available to everyone in this organization. Invite people to the organization to give them access.",
      ),
    ).toBeInTheDocument();
    expect(screen.getByText("Public workspace")).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "Invite" }),
    ).toBeInTheDocument();

    fireEvent.click(
      screen.getByRole("button", { name: "Manage organization members" }),
    );

    expect(window.location.hash).toBe("#organizations/org-1");
    expect(onClose).toHaveBeenCalled();
  });

  it("shows private workspace copy, pending invites, and role dropdowns", () => {
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

    expect(
      screen.getByText(
        "Only invited organization members can access this workspace. If someone is not in the organization yet, they'll be invited first and granted workspace access after signup.",
      ),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "Invite" }),
    ).toBeInTheDocument();
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
      screen.getByText(
        "Organization admins can invite people and manage private workspace access.",
      ),
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

    fireEvent.change(screen.getByPlaceholderText("Enter email address"), {
      target: { value: "invitee@example.com" },
    });
    fireEvent.click(
      screen.getByRole("button", { name: "Invite" }),
    );

    await waitFor(() => {
      expect(mockCreateWorkspace).toHaveBeenCalledWith({
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

    // Open the role dropdown for the member
    const editorButton = screen.getByRole("button", { name: /Editor/ });
    fireEvent.click(editorButton);

    // Click "Remove from workspace" in the dropdown
    const removeItem = await screen.findByText("Remove from workspace");
    fireEvent.click(removeItem);

    await waitFor(() => {
      expect(mockRemoveWorkspaceMember).toHaveBeenCalledWith({
        workspaceId: "ws-1",
        email: "member@example.com",
      });
    });
    expect(mockToastSuccess).toHaveBeenCalledWith("Workspace access removed");
  });
});
