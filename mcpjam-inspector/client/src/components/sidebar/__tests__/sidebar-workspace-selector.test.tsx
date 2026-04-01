import { fireEvent, render, screen } from "@testing-library/react";
import type { ButtonHTMLAttributes, ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { SidebarWorkspaceSelector } from "../sidebar-workspace-selector";

const mockUseConvexAuth = vi.fn();
const mockUseWorkspaceMembers = vi.fn();

vi.mock("convex/react", () => ({
  useConvexAuth: (...args: unknown[]) => mockUseConvexAuth(...args),
}));

vi.mock("@/hooks/useWorkspaces", () => ({
  useWorkspaceMembers: (...args: unknown[]) => mockUseWorkspaceMembers(...args),
}));

vi.mock("@/components/ui/sidebar", () => ({
  SidebarMenu: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  SidebarMenuItem: ({ children }: { children: ReactNode }) => (
    <div>{children}</div>
  ),
  SidebarMenuButton: ({
    children,
    ...props
  }: ButtonHTMLAttributes<HTMLButtonElement>) => (
    <button type="button" {...props}>
      {children}
    </button>
  ),
  useSidebar: () => ({ isMobile: false }),
}));

vi.mock("@/components/ui/dropdown-menu", () => ({
  DropdownMenu: ({ children }: { children: ReactNode }) => (
    <div>{children}</div>
  ),
  DropdownMenuTrigger: ({ children }: { children: ReactNode }) => (
    <div>{children}</div>
  ),
  DropdownMenuContent: ({ children }: { children: ReactNode }) => (
    <div>{children}</div>
  ),
  DropdownMenuItem: ({
    children,
    onClick,
    className,
    disabled,
    title,
  }: {
    children: ReactNode;
    onClick?: () => void;
    className?: string;
    disabled?: boolean;
    title?: string;
  }) => (
    <div
      className={className}
      onClick={disabled ? undefined : onClick}
      role="menuitem"
      aria-disabled={disabled ? "true" : "false"}
      title={title}
    >
      {children}
    </div>
  ),
  DropdownMenuSeparator: () => <hr />,
}));

vi.mock("@/components/ui/tooltip", () => ({
  Tooltip: ({ children }: { children: ReactNode }) => <>{children}</>,
  TooltipTrigger: ({ children }: { children: ReactNode }) => <>{children}</>,
  TooltipContent: ({ children }: { children: ReactNode }) => (
    <span>{children}</span>
  ),
}));

vi.mock("@/components/learn-more/LearnMoreHoverCard", () => ({
  LearnMoreHoverCard: ({
    tabId,
    children,
  }: {
    tabId: string;
    children: ReactNode;
  }) => <div data-testid={`learn-more-${tabId}`}>{children}</div>,
}));

describe("SidebarWorkspaceSelector", () => {
  const baseWorkspaces = {
    "workspace-owner": {
      id: "workspace-owner",
      name: "Owner Workspace",
      servers: {},
      createdAt: new Date(),
      updatedAt: new Date(),
      canDeleteWorkspace: true,
      sharedWorkspaceId: "shared-owner",
    },
    "workspace-member": {
      id: "workspace-member",
      name: "Member Workspace",
      servers: {},
      createdAt: new Date(),
      updatedAt: new Date(),
      canDeleteWorkspace: false,
      sharedWorkspaceId: "shared-member",
    },
  };

  beforeEach(() => {
    vi.clearAllMocks();
    mockUseConvexAuth.mockReturnValue({
      isAuthenticated: true,
      isLoading: false,
    });
    mockUseWorkspaceMembers.mockReturnValue({
      activeMembers: [],
      isLoading: false,
    });
  });

  it("computes delete permissions per workspace row instead of using the active workspace", () => {
    render(
      <SidebarWorkspaceSelector
        activeWorkspaceId="workspace-owner"
        workspaces={baseWorkspaces}
        onSwitchWorkspace={vi.fn()}
        onCreateWorkspace={vi.fn(async () => "workspace-created")}
        onDeleteWorkspace={vi.fn()}
      />,
    );

    expect(
      screen.getByRole("button", { name: "Delete workspace Owner Workspace" }),
    ).toBeEnabled();
    expect(
      screen.getByRole("button", { name: "Delete workspace Member Workspace" }),
    ).toBeDisabled();
    expect(
      screen.getByRole("button", { name: "Delete workspace Member Workspace" }),
    ).toHaveAttribute(
      "title",
      "Only workspace admins can delete this workspace",
    );
  });

  it("calls onDeleteWorkspace for rows the user can delete", () => {
    const onDeleteWorkspace = vi.fn();

    render(
      <SidebarWorkspaceSelector
        activeWorkspaceId="workspace-owner"
        workspaces={{
          "workspace-owner": baseWorkspaces["workspace-owner"],
        }}
        onSwitchWorkspace={vi.fn()}
        onCreateWorkspace={vi.fn(async () => "workspace-created")}
        onDeleteWorkspace={onDeleteWorkspace}
      />,
    );

    fireEvent.click(
      screen.getByRole("button", { name: "Delete workspace Owner Workspace" }),
    );

    expect(onDeleteWorkspace).toHaveBeenCalledWith("workspace-owner");
  });

  it("disables Add Workspace for free organizations at cap", () => {
    render(
      <SidebarWorkspaceSelector
        activeWorkspaceId="workspace-owner"
        workspaces={baseWorkspaces}
        onSwitchWorkspace={vi.fn()}
        onCreateWorkspace={vi.fn(async () => "workspace-created")}
        onDeleteWorkspace={vi.fn()}
        isCreateDisabled={true}
        createDisabledReason="This organization has reached its workspace limit (1). Upgrade to create more workspaces."
      />,
    );

    expect(
      screen.getByRole("menuitem", { name: "Add Workspace" }),
    ).toHaveAttribute("aria-disabled", "true");
    expect(
      screen.getByRole("menuitem", { name: "Add Workspace" }),
    ).toHaveAttribute(
      "title",
      "This organization has reached its workspace limit (1). Upgrade to create more workspaces.",
    );
    expect(
      screen.getByText(
        "This organization has reached its workspace limit (1). Upgrade to create more workspaces.",
      ),
    ).toBeInTheDocument();
  });

  it("keeps Add Workspace enabled when the org is not locked", () => {
    const onCreateWorkspace = vi.fn(async () => "workspace-created");

    render(
      <SidebarWorkspaceSelector
        activeWorkspaceId="workspace-owner"
        workspaces={baseWorkspaces}
        onSwitchWorkspace={vi.fn()}
        onCreateWorkspace={onCreateWorkspace}
        onDeleteWorkspace={vi.fn()}
      />,
    );

    fireEvent.click(screen.getByRole("menuitem", { name: "Add Workspace" }));

    expect(onCreateWorkspace).toHaveBeenCalledWith("New workspace", true);
    expect(
      screen.getByRole("menuitem", { name: "Add Workspace" }),
    ).toHaveAttribute("aria-disabled", "false");
  });

  it("keeps the workspace trigger wrapped with learn more content", () => {
    render(
      <SidebarWorkspaceSelector
        activeWorkspaceId="workspace-owner"
        workspaces={{
          "workspace-owner": {
            id: "workspace-owner",
            name: "Owner Workspace",
            servers: {},
            createdAt: new Date(),
            updatedAt: new Date(),
          },
        }}
        onSwitchWorkspace={vi.fn()}
        onCreateWorkspace={vi.fn(async () => "workspace-created")}
        onDeleteWorkspace={vi.fn()}
        onLearnMoreExpand={vi.fn()}
      />,
    );

    expect(screen.getByTestId("learn-more-workspaces")).toBeInTheDocument();
    expect(screen.getByTestId("learn-more-workspaces")).toHaveTextContent(
      "Owner Workspace",
    );
  });
});
