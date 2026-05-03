import {
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import type { ButtonHTMLAttributes, ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mockUseConvexAuth = vi.fn();
const mockUseProjectMembers = vi.fn();
const mockUseOrganizationQueries = vi.fn();

vi.mock("convex/react", () => ({
  useConvexAuth: (...args: unknown[]) => mockUseConvexAuth(...args),
}));

vi.mock("@/hooks/useProjects", () => ({
  useProjectMembers: (...args: unknown[]) => mockUseProjectMembers(...args),
}));

vi.mock("@/hooks/useOrganizations", () => ({
  useOrganizationQueries: (...args: unknown[]) =>
    mockUseOrganizationQueries(...args),
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

const mockCreateOrgDialog = vi.fn();
vi.mock("@/components/organization/CreateOrganizationDialog", () => ({
  CreateOrganizationDialog: (props: unknown) => {
    mockCreateOrgDialog(props);
    return null;
  },
}));

import { SidebarContextSwitcher } from "../sidebar-context-switcher";

const orgs = [
  {
    _id: "org_a",
    name: "Acme",
    myRole: "admin",
    createdBy: "u",
    createdAt: 0,
    updatedAt: 2,
  },
  {
    _id: "org_b",
    name: "Nimbus",
    myRole: "member",
    createdBy: "u",
    createdAt: 0,
    updatedAt: 1,
  },
];

const projects = {
  p1: {
    id: "p1",
    name: "Inspector",
    servers: {},
    createdAt: new Date(),
    updatedAt: new Date(),
    organizationId: "org_a",
  },
  p2: {
    id: "p2",
    name: "Sandbox",
    servers: {},
    createdAt: new Date(),
    updatedAt: new Date(),
    organizationId: "org_a",
    canDeleteProject: true,
    sharedProjectId: "shared-p2",
  },
  p3: {
    id: "p3",
    name: "Nimbus Project",
    servers: {},
    createdAt: new Date(),
    updatedAt: new Date(),
    organizationId: "org_b",
  },
};

function openChipPopover() {
  fireEvent.click(screen.getByTestId("org-chip-button"));
}

describe("SidebarContextSwitcher", () => {
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
    mockUseOrganizationQueries.mockReturnValue({
      sortedOrganizations: orgs,
      isLoading: false,
    });
  });

  it("renders trigger with project name and active org name", () => {
    render(
      <SidebarContextSwitcher
        activeProjectId="p1"
        activeOrganizationId="org_a"
        projects={projects}
        onSwitchProject={vi.fn()}
        onCreateProject={vi.fn(async () => "")}
        onDeleteProject={vi.fn()}
      />
    );
    // Project name appears in trigger; org name in trigger AND chip header.
    expect(screen.getAllByText("Inspector").length).toBeGreaterThanOrEqual(1);
    expect(screen.getAllByText("Acme").length).toBeGreaterThanOrEqual(1);
  });

  it("shows the active org in the chip header and projects in the body by default", () => {
    render(
      <SidebarContextSwitcher
        activeProjectId="p1"
        activeOrganizationId="org_a"
        projects={projects}
        onSwitchProject={vi.fn()}
        onCreateProject={vi.fn(async () => "")}
        onDeleteProject={vi.fn()}
      />
    );
    // Chip header label
    expect(screen.getByText("Organization")).toBeInTheDocument();
    // Projects body label
    expect(screen.getByText("Projects")).toBeInTheDocument();
    // Active org's projects rendered in body
    expect(screen.getByText("Sandbox")).toBeInTheDocument();
    // Other orgs' projects not in body by default
    expect(screen.queryByText("Nimbus Project")).not.toBeInTheDocument();
    // Org popover is closed by default
    expect(screen.queryByTestId("org-popover")).not.toBeInTheDocument();
  });

  it("opens the org popover when chip is clicked, listing all organizations", () => {
    render(
      <SidebarContextSwitcher
        activeProjectId="p1"
        activeOrganizationId="org_a"
        projects={projects}
        onSwitchProject={vi.fn()}
        onCreateProject={vi.fn(async () => "")}
        onDeleteProject={vi.fn()}
      />
    );
    openChipPopover();
    expect(screen.getByTestId("org-popover")).toBeInTheDocument();
    expect(screen.getByTestId("org-row-org_a")).toBeInTheDocument();
    expect(screen.getByTestId("org-row-org_b")).toBeInTheDocument();
  });

  it("clicking an org in the popover commits the switch via onSwitchActiveOrganization (no navigation)", () => {
    const onSwitchOrganization = vi.fn();
    const onSwitchActiveOrganization = vi.fn();
    render(
      <SidebarContextSwitcher
        activeProjectId="p1"
        activeOrganizationId="org_a"
        projects={projects}
        onSwitchProject={vi.fn()}
        onCreateProject={vi.fn(async () => "")}
        onDeleteProject={vi.fn()}
        onSwitchOrganization={onSwitchOrganization}
        onSwitchActiveOrganization={onSwitchActiveOrganization}
      />
    );
    openChipPopover();
    fireEvent.click(screen.getByTestId("org-row-org_b"));
    expect(onSwitchActiveOrganization).toHaveBeenCalledWith("org_b");
    // The navigating handler must NOT fire — staying on the current page is the point.
    expect(onSwitchOrganization).not.toHaveBeenCalled();
    // Popover auto-closes
    expect(screen.queryByTestId("org-popover")).not.toBeInTheDocument();
  });

  it("clicking the already-active org in the popover does not call onSwitchActiveOrganization", () => {
    const onSwitchActiveOrganization = vi.fn();
    render(
      <SidebarContextSwitcher
        activeProjectId="p1"
        activeOrganizationId="org_a"
        projects={projects}
        onSwitchProject={vi.fn()}
        onCreateProject={vi.fn(async () => "")}
        onDeleteProject={vi.fn()}
        onSwitchActiveOrganization={onSwitchActiveOrganization}
      />
    );
    openChipPopover();
    fireEvent.click(screen.getByTestId("org-row-org_a"));
    expect(onSwitchActiveOrganization).not.toHaveBeenCalled();
  });

  it("clicking the gear icon in an org popover row navigates via onSwitchOrganization", () => {
    const onSwitchOrganization = vi.fn();
    render(
      <SidebarContextSwitcher
        activeProjectId="p1"
        activeOrganizationId="org_a"
        projects={projects}
        onSwitchProject={vi.fn()}
        onCreateProject={vi.fn(async () => "")}
        onDeleteProject={vi.fn()}
        onSwitchOrganization={onSwitchOrganization}
      />
    );
    openChipPopover();
    const popover = screen.getByTestId("org-popover");
    fireEvent.click(
      within(popover).getByRole("button", { name: "Open Acme settings" })
    );
    expect(onSwitchOrganization).toHaveBeenCalledWith("org_a", "overview");
  });

  it("only renders the gear icon (in the popover) for orgs where the user is admin or owner", () => {
    render(
      <SidebarContextSwitcher
        activeProjectId="p1"
        activeOrganizationId="org_a"
        projects={projects}
        onSwitchProject={vi.fn()}
        onCreateProject={vi.fn(async () => "")}
        onDeleteProject={vi.fn()}
        onSwitchOrganization={vi.fn()}
      />
    );
    openChipPopover();
    const popover = screen.getByTestId("org-popover");
    expect(
      within(popover).getByRole("button", { name: "Open Acme settings" })
    ).toBeInTheDocument();
    expect(
      within(popover).queryByRole("button", { name: "Open Nimbus settings" })
    ).not.toBeInTheDocument();
  });

  it("renders an always-visible org settings gear next to the chevron when the user is admin/owner of the active org", () => {
    const onSwitchOrganization = vi.fn();
    render(
      <SidebarContextSwitcher
        activeProjectId="p1"
        activeOrganizationId="org_a"
        projects={projects}
        onSwitchProject={vi.fn()}
        onCreateProject={vi.fn(async () => "")}
        onDeleteProject={vi.fn()}
        onSwitchOrganization={onSwitchOrganization}
      />
    );
    // Chip-level gear is rendered without opening the popover
    const chipGear = screen.getByRole("button", { name: "Open Acme settings" });
    expect(chipGear).toBeInTheDocument();
    fireEvent.click(chipGear);
    expect(onSwitchOrganization).toHaveBeenCalledWith("org_a", "overview");
  });

  it("hides the chip-level org settings gear when the user is not admin/owner", () => {
    render(
      <SidebarContextSwitcher
        activeProjectId="p3"
        activeOrganizationId="org_b"
        projects={projects}
        onSwitchProject={vi.fn()}
        onCreateProject={vi.fn(async () => "")}
        onDeleteProject={vi.fn()}
        onSwitchOrganization={vi.fn()}
      />
    );
    // Nimbus's myRole is "member" — no chip gear
    expect(
      screen.queryByRole("button", { name: "Open Nimbus settings" })
    ).not.toBeInTheDocument();
  });

  it("clicking a project row calls onSwitchProject", () => {
    const onSwitchProject = vi.fn();
    render(
      <SidebarContextSwitcher
        activeProjectId="p1"
        activeOrganizationId="org_a"
        projects={projects}
        onSwitchProject={onSwitchProject}
        onCreateProject={vi.fn(async () => "")}
        onDeleteProject={vi.fn()}
      />
    );
    fireEvent.click(screen.getByText("Sandbox"));
    expect(onSwitchProject).toHaveBeenCalledWith("p2");
  });

  it("renders an always-visible per-row settings gear when onNavigateToSettings is provided", () => {
    render(
      <SidebarContextSwitcher
        activeProjectId="p1"
        activeOrganizationId="org_a"
        projects={projects}
        onSwitchProject={vi.fn()}
        onCreateProject={vi.fn(async () => "")}
        onDeleteProject={vi.fn()}
        onNavigateToSettings={vi.fn()}
      />
    );
    expect(
      screen.getByRole("button", { name: "Open Inspector settings" })
    ).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "Open Sandbox settings" })
    ).toBeInTheDocument();
  });

  it("clicking the per-row gear opens settings for that project (switching first if needed)", async () => {
    const onSwitchProject = vi.fn();
    const onNavigateToSettings = vi.fn();
    render(
      <SidebarContextSwitcher
        activeProjectId="p1"
        activeOrganizationId="org_a"
        projects={projects}
        onSwitchProject={onSwitchProject}
        onCreateProject={vi.fn(async () => "")}
        onDeleteProject={vi.fn()}
        onNavigateToSettings={onNavigateToSettings}
      />
    );
    fireEvent.click(
      screen.getByRole("button", { name: "Open Sandbox settings" })
    );
    expect(onSwitchProject).toHaveBeenCalledWith("p2");
    await waitFor(() => {
      expect(onNavigateToSettings).toHaveBeenCalled();
    });
  });

  it("waits for another project to become active before opening its settings", async () => {
    let resolveSwitch: () => void = () => {};
    const onSwitchProject = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          resolveSwitch = resolve;
        })
    );
    const onNavigateToSettings = vi.fn();
    render(
      <SidebarContextSwitcher
        activeProjectId="p1"
        activeOrganizationId="org_a"
        projects={projects}
        onSwitchProject={onSwitchProject}
        onCreateProject={vi.fn(async () => "")}
        onDeleteProject={vi.fn()}
        onNavigateToSettings={onNavigateToSettings}
      />
    );
    fireEvent.click(
      screen.getByRole("button", { name: "Open Sandbox settings" })
    );
    expect(onSwitchProject).toHaveBeenCalledWith("p2");
    expect(onNavigateToSettings).not.toHaveBeenCalled();

    resolveSwitch();
    await waitFor(() => {
      expect(onNavigateToSettings).toHaveBeenCalled();
    });
  });

  it("clicking the per-row gear on the active project navigates without re-switching", () => {
    const onSwitchProject = vi.fn();
    const onNavigateToSettings = vi.fn();
    render(
      <SidebarContextSwitcher
        activeProjectId="p1"
        activeOrganizationId="org_a"
        projects={projects}
        onSwitchProject={onSwitchProject}
        onCreateProject={vi.fn(async () => "")}
        onDeleteProject={vi.fn()}
        onNavigateToSettings={onNavigateToSettings}
      />
    );
    fireEvent.click(
      screen.getByRole("button", { name: "Open Inspector settings" })
    );
    expect(onSwitchProject).not.toHaveBeenCalled();
    expect(onNavigateToSettings).toHaveBeenCalled();
  });

  it("does not render the standalone Project Settings footer item (settings is per-row now)", () => {
    render(
      <SidebarContextSwitcher
        activeProjectId="p1"
        activeOrganizationId="org_a"
        projects={projects}
        onSwitchProject={vi.fn()}
        onCreateProject={vi.fn(async () => "")}
        onDeleteProject={vi.fn()}
        onNavigateToSettings={vi.fn()}
      />
    );
    expect(
      screen.queryByRole("menuitem", { name: "Project Settings" })
    ).not.toBeInTheDocument();
  });

  it("renders per-project member avatars when members exist", () => {
    mockUseProjectMembers.mockReturnValue({
      activeMembers: [
        {
          _id: "m1",
          email: "a@x.com",
          user: { name: "Alice", email: "a@x.com", imageUrl: "" },
        },
        {
          _id: "m2",
          email: "b@x.com",
          user: { name: "Bob", email: "b@x.com", imageUrl: "" },
        },
      ],
      isLoading: false,
    });
    render(
      <SidebarContextSwitcher
        activeProjectId="p1"
        activeOrganizationId="org_a"
        projects={projects}
        onSwitchProject={vi.fn()}
        onCreateProject={vi.fn(async () => "")}
        onDeleteProject={vi.fn()}
      />
    );
    // Both initials render somewhere in the menu
    expect(screen.getAllByTitle("Alice").length).toBeGreaterThan(0);
    expect(screen.getAllByTitle("Bob").length).toBeGreaterThan(0);
  });

  it("collapses excess project members into a +N overflow chip", () => {
    mockUseProjectMembers.mockReturnValue({
      activeMembers: [
        {
          _id: "m1",
          email: "a@x.com",
          user: { name: "Alice", email: "a@x.com", imageUrl: "" },
        },
        {
          _id: "m2",
          email: "b@x.com",
          user: { name: "Bob", email: "b@x.com", imageUrl: "" },
        },
        {
          _id: "m3",
          email: "c@x.com",
          user: { name: "Cara", email: "c@x.com", imageUrl: "" },
        },
        {
          _id: "m4",
          email: "d@x.com",
          user: { name: "Dan", email: "d@x.com", imageUrl: "" },
        },
        {
          _id: "m5",
          email: "e@x.com",
          user: { name: "Eve", email: "e@x.com", imageUrl: "" },
        },
      ],
      isLoading: false,
    });
    render(
      <SidebarContextSwitcher
        activeProjectId="p1"
        activeOrganizationId="org_a"
        projects={{ p1: projects.p1 }}
        onSwitchProject={vi.fn()}
        onCreateProject={vi.fn(async () => "")}
        onDeleteProject={vi.fn()}
      />
    );
    expect(screen.getByTitle("2 more")).toBeInTheDocument();
  });

  it("clicking the 'New organization' header button opens the create org dialog", () => {
    render(
      <SidebarContextSwitcher
        activeProjectId="p1"
        activeOrganizationId="org_a"
        projects={projects}
        onSwitchProject={vi.fn()}
        onCreateProject={vi.fn(async () => "")}
        onDeleteProject={vi.fn()}
      />
    );
    fireEvent.click(screen.getByRole("button", { name: "New organization" }));
    expect(mockCreateOrgDialog).toHaveBeenCalled();
    const lastCall = mockCreateOrgDialog.mock.calls.at(-1)?.[0] as {
      open: boolean;
    };
    expect(lastCall.open).toBe(true);
  });

  it("clicking the 'Add project' header button calls onCreateProject with a unique name", () => {
    const onCreateProject = vi.fn(async () => "");
    render(
      <SidebarContextSwitcher
        activeProjectId="p1"
        activeOrganizationId="org_a"
        projects={projects}
        onSwitchProject={vi.fn()}
        onCreateProject={onCreateProject}
        onDeleteProject={vi.fn()}
      />
    );
    fireEvent.click(screen.getByRole("button", { name: "Add project" }));
    expect(onCreateProject).toHaveBeenCalledWith("New project", true);
  });

  it("disables the Add project button when isCreateDisabled is true", () => {
    render(
      <SidebarContextSwitcher
        activeProjectId="p1"
        activeOrganizationId="org_a"
        projects={projects}
        onSwitchProject={vi.fn()}
        onCreateProject={vi.fn(async () => "")}
        onDeleteProject={vi.fn()}
        isCreateDisabled
        createDisabledReason="Project limit reached. Upgrade to add more."
      />
    );
    const button = screen.getByRole("button", { name: "Add project" });
    expect(button).toBeDisabled();
    expect(button).toHaveAttribute(
      "title",
      "Project limit reached. Upgrade to add more."
    );
  });

  it("hides the org chip badge on the trigger when there is only one organization", () => {
    mockUseOrganizationQueries.mockReturnValue({
      sortedOrganizations: [orgs[0]],
      isLoading: false,
    });
    const { container } = render(
      <SidebarContextSwitcher
        activeProjectId="p1"
        activeOrganizationId="org_a"
        projects={{ p1: projects.p1 }}
        onSwitchProject={vi.fn()}
        onCreateProject={vi.fn(async () => "")}
        onDeleteProject={vi.fn()}
      />
    );
    expect(screen.getAllByText("Inspector").length).toBeGreaterThanOrEqual(1);
    const chip = container.querySelector(
      '[aria-hidden="true"][class*="-bottom-0.5"]'
    );
    expect(chip).toBeNull();
  });

  it("renders skeleton when isLoading is true", () => {
    const { container } = render(
      <SidebarContextSwitcher
        activeProjectId="p1"
        activeOrganizationId="org_a"
        projects={projects}
        onSwitchProject={vi.fn()}
        onCreateProject={vi.fn(async () => "")}
        onDeleteProject={vi.fn()}
        isLoading
      />
    );
    expect(
      container.querySelectorAll("[data-slot='skeleton']").length
    ).toBeGreaterThan(0);
  });

  it("computes delete permissions per project row", () => {
    render(
      <SidebarContextSwitcher
        activeProjectId="p1"
        activeOrganizationId="org_a"
        projects={{
          ...projects,
          p2: {
            ...projects.p2,
            canDeleteProject: false,
          },
        }}
        onSwitchProject={vi.fn()}
        onCreateProject={vi.fn(async () => "")}
        onDeleteProject={vi.fn()}
      />
    );
    expect(
      screen.getByRole("button", { name: "Delete project Sandbox" })
    ).toBeDisabled();
  });

  it("keeps the trigger wrapped with learn more content when onLearnMoreExpand is provided", () => {
    render(
      <SidebarContextSwitcher
        activeProjectId="p1"
        activeOrganizationId="org_a"
        projects={projects}
        onSwitchProject={vi.fn()}
        onCreateProject={vi.fn(async () => "")}
        onDeleteProject={vi.fn()}
        onLearnMoreExpand={vi.fn()}
      />
    );
    expect(screen.getByTestId("learn-more-projects")).toBeInTheDocument();
    expect(screen.getByTestId("learn-more-projects")).toHaveTextContent(
      "Inspector"
    );
  });

  it("edge case: single org and single project still renders chip and full menu affordances", () => {
    mockUseOrganizationQueries.mockReturnValue({
      sortedOrganizations: [orgs[0]],
      isLoading: false,
    });
    render(
      <SidebarContextSwitcher
        activeProjectId="p1"
        activeOrganizationId="org_a"
        projects={{ p1: projects.p1 }}
        onSwitchProject={vi.fn()}
        onCreateProject={vi.fn(async () => "")}
        onDeleteProject={vi.fn()}
      />
    );
    expect(screen.getAllByText("Inspector").length).toBeGreaterThanOrEqual(1);
    // Chip is rendered
    expect(screen.getByTestId("org-chip-button")).toBeInTheDocument();
    // Open the chip popover; the single org row is visible
    openChipPopover();
    expect(screen.getByTestId("org-row-org_a")).toBeInTheDocument();
    // Section-header affordances are always visible (no popover required)
    expect(
      screen.getByRole("button", { name: "New organization" })
    ).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "Add project" })
    ).toBeInTheDocument();
  });
});
