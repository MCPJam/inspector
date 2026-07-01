import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { ShareProjectDialog } from "../ShareProjectDialog";

const mockCapture = vi.fn();
let mockBillingUiFlag = false;
const mockUseProjectMembers = vi.fn();
const mockUseOrganizationBilling = vi.fn();
const mockResolveBillingGateState = vi.fn();
const mockCreateProject = vi.fn();
const mockInviteProjectMember = vi.fn();
const mockRemoveProjectMember = vi.fn();
const mockUpdateProjectMemberRole = vi.fn();
const mockUpdateProjectInviteRole = vi.fn();
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

vi.mock("@/hooks/useProjects", async () => {
  const actual = await vi.importActual<typeof import("@/hooks/useProjects")>(
    "@/hooks/useProjects",
  );

  return {
    ...actual,
    useProjectMembers: (...args: unknown[]) =>
      mockUseProjectMembers(...args),
    useProjectMutations: () => ({
      createProject: mockCreateProject,
      inviteProjectMember: mockInviteProjectMember,
      removeProjectMember: mockRemoveProjectMember,
      updateProjectMemberRole: mockUpdateProjectMemberRole,
      updateProjectInviteRole: mockUpdateProjectInviteRole,
    }),
  };
});

function createMember({
  email,
  role = "member",
  accessSource = "organization",
  canRemove = false,
  canChangeRole = false,
  projectRole,
  isPending = false,
}: {
  email: string;
  role?: "owner" | "admin" | "member" | "guest";
  accessSource?: "organization" | "project" | "invite";
  canRemove?: boolean;
  canChangeRole?: boolean;
  projectRole?: "admin" | "editor";
  isPending?: boolean;
}) {
  const isOrgPrivileged = role === "owner" || role === "admin";
  const resolvedProjectRole =
    projectRole ?? (isOrgPrivileged ? "admin" : "editor");

  return {
    _id: `${isPending ? "pending" : "member"}-${email}`,
    projectId: "ws-1",
    organizationId: "org-1",
    userId: isPending ? undefined : `user-${email}`,
    email,
    role,
    projectRole: resolvedProjectRole,
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
  overrides: Partial<React.ComponentProps<typeof ShareProjectDialog>> = {},
) {
  const onClose = vi.fn();
  const onProjectShared = vi.fn();

  const renderResult = render(
    <ShareProjectDialog
      isOpen
      onClose={onClose}
      projectName="Acme"
      projectServers={{}}
      sharedProjectId="ws-1"
      organizationId="org-1"
      visibility="public"
      currentUser={
        {
          email: "owner@example.com",
          firstName: "Owner",
          lastName: "Example",
        } as any
      }
      onProjectShared={onProjectShared}
      {...overrides}
    />,
  );

  return {
    ...renderResult,
    onClose,
    onProjectShared,
  };
}

describe("ShareProjectDialog", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    window.location.hash = "";
    mockBillingUiFlag = false;

    mockCreateProject.mockResolvedValue("ws-created");
    mockInviteProjectMember.mockResolvedValue({
      changed: true,
      kind: "project_invite_pending",
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
    mockRemoveProjectMember.mockResolvedValue({
      success: true,
      changed: true,
      removed: "project_access",
    });
    mockUseProjectMembers.mockReturnValue({
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

  it("shows invite form on public project without description text", () => {
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

  it("shows private project with pending invites and role dropdowns", () => {
    mockUseProjectMembers.mockReturnValue({
      members: [
        createMember({
          email: "owner@example.com",
          role: "owner",
        }),
        createMember({
          email: "member@example.com",
          role: "member",
          accessSource: "project",
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
          accessSource: "project",
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
    mockUseProjectMembers.mockReturnValue({
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
      screen.getByText("Only project admins can invite people."),
    ).toBeInTheDocument();
    expect(screen.queryByText("Invite with email")).not.toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "Invite" }),
    ).not.toBeInTheDocument();
  });

  it("creates the project before inviting on the first share flow", async () => {
    const { onProjectShared } = renderDialog({
      sharedProjectId: null,
      visibility: "private",
    });

    fireEvent.change(screen.getByPlaceholderText("Add people, emails..."), {
      target: { value: "invitee@example.com" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Invite" }));

    await waitFor(() => {
      expect(mockCreateProject).toHaveBeenCalledWith({
        organizationId: "org-1",
        name: "Acme",
        servers: {},
        visibility: "private",
      });
    });
    expect(onProjectShared).toHaveBeenCalledWith("ws-created");
    expect(mockInviteProjectMember).toHaveBeenCalledWith({
      projectId: "ws-created",
      email: "invitee@example.com",
      role: "editor",
    });
    expect(mockToastSuccess).toHaveBeenCalledWith(
      "Invitation sent to invitee@example.com. They'll get project access once they join the organization.",
    );
  });

  it("tells admins to finish paid seat payment before invitees get access", async () => {
    mockInviteProjectMember.mockResolvedValueOnce({
      changed: true,
      kind: "project_invite_pending",
      isPending: true,
      requiresSeatPayment: true,
    });

    renderDialog({
      visibility: "private",
    });

    fireEvent.change(screen.getByPlaceholderText("Add people, emails..."), {
      target: { value: "invitee@example.com" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Invite" }));

    await waitFor(() => {
      expect(mockToastSuccess).toHaveBeenCalledWith(
        "Invitation saved for invitee@example.com. Finish paid seat payment in organization settings before they get access.",
      );
    });
  });

  it("shows a project picker only when multiple projects are available", () => {
    renderDialog({
      availableProjects: {
        "project-a": {
          id: "project-a",
          name: "Acme",
          servers: {},
          createdAt: new Date(),
          updatedAt: new Date(),
          sharedProjectId: "ws-1",
          organizationId: "org-1",
          visibility: "public",
        },
      },
      activeProjectId: "project-a",
    });

    expect(
      screen.queryByRole("button", { name: "Select project" }),
    ).not.toBeInTheDocument();
  });

  it("lets multi-project users switch invite targets inside the dialog", async () => {
    mockUseProjectMembers.mockImplementation(
      ({ projectId }: { projectId: string | null }) => {
        const memberEmail =
          projectId === "ws-2"
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
      availableProjects: {
        "project-a": {
          id: "project-a",
          name: "Acme",
          servers: {},
          createdAt: new Date(),
          updatedAt: new Date(),
          sharedProjectId: "ws-1",
          organizationId: "org-1",
          visibility: "public",
        },
        "project-b": {
          id: "project-b",
          name: "Beta",
          servers: {},
          createdAt: new Date(),
          updatedAt: new Date(),
          sharedProjectId: "ws-2",
          organizationId: "org-1",
          visibility: "private",
        },
        "project-c": {
          id: "project-c",
          name: "Gamma",
          servers: {},
          createdAt: new Date(),
          updatedAt: new Date(),
          sharedProjectId: "ws-3",
          organizationId: "org-1",
          visibility: "public",
        },
      },
      activeProjectId: "project-a",
    });

    expect(
      screen.getByRole("heading", { name: 'Share "Acme" Project' }),
    ).toBeInTheDocument();
    expect(
      screen.getAllByText("alpha-member@example.com").length,
    ).toBeGreaterThan(0);

    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: "Select project" }));
    await user.click(screen.getByRole("menuitemradio", { name: /Beta/ }));

    expect(
      screen.getByRole("heading", { name: 'Share "Beta" Project' }),
    ).toBeInTheDocument();
    expect(
      screen.getAllByText("beta-member@example.com").length,
    ).toBeGreaterThan(0);
    expect(screen.getByText("Private to members")).toBeInTheDocument();
    expect(screen.queryAllByText("alpha-member@example.com")).toHaveLength(0);
  });

  it("keeps the chosen project selected when projects refresh while open", async () => {
    const currentUser = {
      email: "owner@example.com",
      firstName: "Owner",
      lastName: "Example",
    } as any;
    const availableProjects = {
      "project-a": {
        id: "project-a",
        name: "Acme",
        servers: {},
        createdAt: new Date("2026-04-01T00:00:00Z"),
        updatedAt: new Date("2026-04-01T00:00:00Z"),
        sharedProjectId: "ws-1",
        organizationId: "org-1",
        visibility: "public" as const,
      },
      "project-b": {
        id: "project-b",
        name: "Beta",
        servers: {},
        createdAt: new Date("2026-04-02T00:00:00Z"),
        updatedAt: new Date("2026-04-02T00:00:00Z"),
        sharedProjectId: "ws-2",
        organizationId: "org-1",
        visibility: "private" as const,
      },
    };

    const { rerender } = render(
      <ShareProjectDialog
        isOpen
        onClose={vi.fn()}
        projectName="Acme"
        projectServers={{}}
        sharedProjectId="ws-1"
        organizationId="org-1"
        visibility="public"
        currentUser={currentUser}
        onProjectShared={vi.fn()}
        availableProjects={availableProjects}
        activeProjectId="project-a"
      />,
    );

    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: "Select project" }));
    await user.click(screen.getByRole("menuitemradio", { name: /Beta/ }));

    expect(
      screen.getByRole("heading", { name: 'Share "Beta" Project' }),
    ).toBeInTheDocument();

    rerender(
      <ShareProjectDialog
        isOpen
        onClose={vi.fn()}
        projectName="Acme"
        projectServers={{}}
        sharedProjectId="ws-1"
        organizationId="org-1"
        visibility="public"
        currentUser={currentUser}
        onProjectShared={vi.fn()}
        availableProjects={{
          "project-a": {
            ...availableProjects["project-a"],
            updatedAt: new Date("2026-04-03T00:00:00Z"),
          },
          "project-b": {
            ...availableProjects["project-b"],
            updatedAt: new Date("2026-04-04T00:00:00Z"),
          },
        }}
        activeProjectId="project-a"
      />,
    );

    expect(
      screen.getByRole("heading", { name: 'Share "Beta" Project' }),
    ).toBeInTheDocument();
  });

  it("creates and shares the selected project when inviting from the picker", async () => {
    const { onProjectShared } = renderDialog({
      availableProjects: {
        "project-a": {
          id: "project-a",
          name: "Acme",
          servers: {},
          createdAt: new Date(),
          updatedAt: new Date(),
          sharedProjectId: "ws-1",
          organizationId: "org-1",
          visibility: "public",
        },
        "project-b": {
          id: "project-b",
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
      activeProjectId: "project-a",
    });

    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: "Select project" }));
    await user.click(screen.getByRole("menuitemradio", { name: /Beta/ }));

    fireEvent.change(screen.getByPlaceholderText("Add people, emails..."), {
      target: { value: "invitee@example.com" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Invite" }));

    await waitFor(() => {
      expect(mockCreateProject).toHaveBeenCalledWith(
        expect.objectContaining({
          organizationId: "org-1",
          name: "Beta",
          visibility: "private",
        }),
      );
    });
    expect(onProjectShared).toHaveBeenCalledWith("ws-created", "project-b");
    expect(mockInviteProjectMember).toHaveBeenCalledWith({
      projectId: "ws-created",
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
      <ShareProjectDialog
        isOpen
        onClose={vi.fn()}
        projectName="Acme"
        projectServers={{}}
        sharedProjectId="ws-1"
        organizationId="org-1"
        visibility="public"
        currentUser={
          {
            email: "owner@example.com",
            firstName: "Owner",
            lastName: "Example",
          } as any
        }
        onProjectShared={vi.fn()}
      />,
    );

    expect(
      screen.queryByTestId("member-limit-upsell"),
    ).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Invite" })).toBeEnabled();
  });

  it("calls the project-scoped removal mutation via role dropdown", async () => {
    mockUseProjectMembers.mockReturnValue({
      members: [
        createMember({
          email: "owner@example.com",
          role: "owner",
        }),
        createMember({
          email: "member@example.com",
          role: "member",
          accessSource: "project",
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
          accessSource: "project",
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

    // Click "Remove from project" in the dropdown
    const removeItem = await screen.findByText("Remove from project");
    await user.click(removeItem);

    await waitFor(() => {
      expect(mockRemoveProjectMember).toHaveBeenCalledWith({
        projectId: "ws-1",
        email: "member@example.com",
      });
    });
    expect(mockToastSuccess).toHaveBeenCalledWith("Project access removed");
  });
});
