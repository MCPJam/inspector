import { fireEvent, render, screen } from "@testing-library/react";
import type { ButtonHTMLAttributes, ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { SidebarProjectSelector } from "../sidebar-project-selector";

const mockUseConvexAuth = vi.fn();
const mockUseProjectMembers = vi.fn();

vi.mock("convex/react", () => ({
  useConvexAuth: (...args: unknown[]) => mockUseConvexAuth(...args),
}));

vi.mock("@/hooks/useProjects", () => ({
  useProjectMembers: (...args: unknown[]) => mockUseProjectMembers(...args),
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

vi.mock("@mcpjam/design-system/dropdown-menu", () => ({
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

vi.mock("@mcpjam/design-system/tooltip", () => ({
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

describe("SidebarProjectSelector", () => {
  const baseProjects = {
    "project-owner": {
      id: "project-owner",
      name: "Owner Project",
      servers: {},
      createdAt: new Date(),
      updatedAt: new Date(),
      canDeleteProject: true,
      sharedProjectId: "shared-owner",
    },
    "project-member": {
      id: "project-member",
      name: "Member Project",
      servers: {},
      createdAt: new Date(),
      updatedAt: new Date(),
      canDeleteProject: false,
      sharedProjectId: "shared-member",
    },
  };

  beforeEach(() => {
    vi.clearAllMocks();
    mockUseConvexAuth.mockReturnValue({
      isAuthenticated: true,
      isLoading: false,
    });
    mockUseProjectMembers.mockReturnValue({
      activeMembers: [],
      isLoading: false,
    });
  });

  it("computes delete permissions per project row instead of using the active project", () => {
    render(
      <SidebarProjectSelector
        activeProjectId="project-owner"
        projects={baseProjects}
        onSwitchProject={vi.fn()}
        onCreateProject={vi.fn(async () => "project-created")}
        onDeleteProject={vi.fn()}
      />,
    );

    expect(
      screen.getByRole("button", { name: "Delete project Owner Project" }),
    ).toBeEnabled();
    expect(
      screen.getByRole("button", { name: "Delete project Member Project" }),
    ).toBeDisabled();
    expect(
      screen.getByRole("button", { name: "Delete project Member Project" }),
    ).toHaveAttribute(
      "title",
      "Only project admins can delete this project",
    );
  });

  it("calls onDeleteProject for rows the user can delete", () => {
    const onDeleteProject = vi.fn();

    render(
      <SidebarProjectSelector
        activeProjectId="project-owner"
        projects={{
          "project-owner": baseProjects["project-owner"],
        }}
        onSwitchProject={vi.fn()}
        onCreateProject={vi.fn(async () => "project-created")}
        onDeleteProject={onDeleteProject}
      />,
    );

    fireEvent.click(
      screen.getByRole("button", { name: "Delete project Owner Project" }),
    );

    expect(onDeleteProject).toHaveBeenCalledWith("project-owner");
  });

  it("disables Add Project for free organizations at cap", () => {
    render(
      <SidebarProjectSelector
        activeProjectId="project-owner"
        projects={baseProjects}
        onSwitchProject={vi.fn()}
        onCreateProject={vi.fn(async () => "project-created")}
        onDeleteProject={vi.fn()}
        isCreateDisabled={true}
        createDisabledReason="This organization has reached its project limit (1). Upgrade to create more projects."
      />,
    );

    expect(
      screen.getByRole("menuitem", { name: "Add Project" }),
    ).toHaveAttribute("aria-disabled", "true");
    expect(
      screen.getByRole("menuitem", { name: "Add Project" }),
    ).toHaveAttribute(
      "title",
      "This organization has reached its project limit (1). Upgrade to create more projects.",
    );
    expect(
      screen.getByText(
        "This organization has reached its project limit (1). Upgrade to create more projects.",
      ),
    ).toBeInTheDocument();
  });

  it("keeps Add Project enabled when the org is not locked", () => {
    const onCreateProject = vi.fn(async () => "project-created");

    render(
      <SidebarProjectSelector
        activeProjectId="project-owner"
        projects={baseProjects}
        onSwitchProject={vi.fn()}
        onCreateProject={onCreateProject}
        onDeleteProject={vi.fn()}
      />,
    );

    fireEvent.click(screen.getByRole("menuitem", { name: "Add Project" }));

    expect(onCreateProject).toHaveBeenCalledWith("New project", true);
    expect(
      screen.getByRole("menuitem", { name: "Add Project" }),
    ).toHaveAttribute("aria-disabled", "false");
  });

  it("keeps the project trigger wrapped with learn more content", () => {
    render(
      <SidebarProjectSelector
        activeProjectId="project-owner"
        projects={{
          "project-owner": {
            id: "project-owner",
            name: "Owner Project",
            servers: {},
            createdAt: new Date(),
            updatedAt: new Date(),
          },
        }}
        onSwitchProject={vi.fn()}
        onCreateProject={vi.fn(async () => "project-created")}
        onDeleteProject={vi.fn()}
        onLearnMoreExpand={vi.fn()}
      />,
    );

    expect(screen.getByTestId("learn-more-projects")).toBeInTheDocument();
    expect(screen.getByTestId("learn-more-projects")).toHaveTextContent(
      "Owner Project",
    );
  });
});
