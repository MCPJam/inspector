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
const mockUseAuth = vi.fn();

vi.mock("convex/react", () => ({
  useConvexAuth: (...args: unknown[]) => mockUseConvexAuth(...args),
}));

vi.mock("@workos-inc/authkit-react", () => ({
  useAuth: (...args: unknown[]) => mockUseAuth(...args),
}));

vi.mock("@/hooks/useProjects", () => ({
  useProjectMembers: (...args: unknown[]) => mockUseProjectMembers(...args),
}));

vi.mock("@/hooks/useOrganizations", () => ({
  useOrganizationQueries: (...args: unknown[]) =>
    mockUseOrganizationQueries(...args),
}));

vi.mock("@/components/sidebar/sidebar-credit-usage", () => ({
  SidebarCreditUsage: ({
    organizationId,
    variant,
  }: {
    organizationId?: string | null;
    variant?: string;
  }) => (
    <div
      data-testid="sidebar-credit-usage"
      data-org={organizationId ?? ""}
      data-variant={variant}
    />
  ),
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

// Realistic dropdown mock: tracks open state via context so tests exercise
// the real open/close behavior. DropdownMenuContent only renders when open.
vi.mock("@mcpjam/design-system/dropdown-menu", async () => {
  const React = await import("react");
  const Ctx = React.createContext<{
    open: boolean;
    setOpen: (next: boolean) => void;
  } | null>(null);
  return {
    DropdownMenu: ({
      open,
      onOpenChange,
      children,
    }: {
      open?: boolean;
      onOpenChange?: (next: boolean) => void;
      children: ReactNode;
    }) => {
      const [internalOpen, setInternalOpen] = React.useState(false);
      const isControlled = open !== undefined;
      const isOpen = isControlled ? !!open : internalOpen;
      const setOpen = (next: boolean) => {
        if (!isControlled) setInternalOpen(next);
        onOpenChange?.(next);
      };
      return (
        <Ctx.Provider value={{ open: isOpen, setOpen }}>
          {children}
        </Ctx.Provider>
      );
    },
    DropdownMenuTrigger: ({
      children,
      asChild,
    }: {
      children: ReactNode;
      asChild?: boolean;
    }) => {
      const ctx = React.useContext(Ctx);
      const handleClick = () => ctx?.setOpen(!ctx.open);
      if (asChild && React.isValidElement(children)) {
        return React.cloneElement(
          children as React.ReactElement<{ onClick?: () => void }>,
          { onClick: handleClick }
        );
      }
      return (
        <button type="button" onClick={handleClick}>
          {children}
        </button>
      );
    },
    DropdownMenuContent: ({ children }: { children: ReactNode }) => {
      const ctx = React.useContext(Ctx);
      return ctx?.open ? <div>{children}</div> : null;
    },
  };
});

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
    suppressed,
  }: {
    tabId: string;
    children: ReactNode;
    suppressed?: boolean;
  }) => (
    <div
      data-testid={`learn-more-${tabId}`}
      data-suppressed={String(!!suppressed)}
    >
      {children}
    </div>
  ),
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

function openMainDropdown() {
  // Trigger button has aria-label "Switch context: …" or "Switch project: …".
  fireEvent.click(
    screen.getByRole("button", { name: /^Switch (context|project):/ })
  );
}

function openOrgSwitchList() {
  fireEvent.click(screen.getByTestId("switch-org-button"));
}

describe("SidebarContextSwitcher", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockUseConvexAuth.mockReturnValue({
      isAuthenticated: true,
      isLoading: false,
    });
    mockUseAuth.mockReturnValue({
      user: { id: "user_1", email: "user@example.com" },
      signIn: vi.fn(),
    });
    mockUseProjectMembers.mockReturnValue({
      activeMembers: [],
      isLoading: false,
    });
    mockUseOrganizationQueries.mockReturnValue({
      sortedOrganizations: orgs,
      isLoading: false,
      createdCount: 0,
      canCreateOrganization: true,
    });
  });

  it("dropdown content is hidden by default and renders only when the trigger is clicked", () => {
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
    // Closed: menu content is absent.
    expect(screen.queryByText("Projects")).not.toBeInTheDocument();
    expect(screen.queryByTestId("org-context-row")).not.toBeInTheDocument();
    // Open: clicking the trigger reveals the menu.
    openMainDropdown();
    expect(screen.getByText("Projects")).toBeInTheDocument();
    expect(screen.getByTestId("org-context-row")).toBeInTheDocument();
    // Close: clicking the trigger again hides it.
    openMainDropdown();
    expect(screen.queryByText("Projects")).not.toBeInTheDocument();
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

  it("shows projects in the body and the active org as a footer row", () => {
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
    openMainDropdown();
    // Projects body label
    expect(screen.getByText("Projects")).toBeInTheDocument();
    // Active org's projects rendered in body
    expect(screen.getByText("Sandbox")).toBeInTheDocument();
    // Other orgs' projects not in body by default
    expect(screen.queryByText("Nimbus Project")).not.toBeInTheDocument();
    // Active org name appears in the footer context row
    expect(
      within(screen.getByTestId("org-context-row")).getByText("Acme")
    ).toBeInTheDocument();
    // The org switch list is collapsed by default
    expect(screen.queryByTestId("org-switch-list")).not.toBeInTheDocument();
  });

  it("shows the active org's credit usage right below the org", () => {
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
    openMainDropdown();
    const creditUsage = screen.getByTestId("sidebar-credit-usage");
    expect(creditUsage).toHaveAttribute("data-org", "org_a");
    expect(creditUsage).toHaveAttribute("data-variant", "full");
  });

  it("expands the org switch list when 'Switch organization' is clicked, listing all organizations", () => {
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
    openMainDropdown();
    openOrgSwitchList();
    expect(screen.getByTestId("org-switch-list")).toBeInTheDocument();
    expect(screen.getByTestId("org-row-org_a")).toBeInTheDocument();
    expect(screen.getByTestId("org-row-org_b")).toBeInTheDocument();
    // Clicking the toggle again collapses the list
    openOrgSwitchList();
    expect(screen.queryByTestId("org-switch-list")).not.toBeInTheDocument();
  });

  it("clicking an org in the switch list commits the switch via onSwitchActiveOrganization (no navigation)", () => {
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
    openMainDropdown();
    openOrgSwitchList();
    fireEvent.click(screen.getByTestId("org-row-org_b"));
    expect(onSwitchActiveOrganization).toHaveBeenCalledWith("org_b");
    // The navigating handler must NOT fire — staying on the current page is the point.
    expect(onSwitchOrganization).not.toHaveBeenCalled();
    // The whole menu closes after switching
    expect(screen.queryByTestId("org-switch-list")).not.toBeInTheDocument();
  });

  // A `seatPending` org is a paid-seat invite whose membership hasn't linked
  // yet. Every org-scoped query for it is denied server-side, so opening it
  // crashed the route (Sentry INSPECTOR-CLIENT-24C). It stays visible so the
  // user knows they were invited, but it must not be openable.
  it("shows a seat-pending org as disabled with a 'Seat not paid yet' tooltip", () => {
    mockUseOrganizationQueries.mockReturnValue({
      sortedOrganizations: [orgs[0], { ...orgs[1], seatPending: true }],
      isLoading: false,
      createdCount: 0,
      canCreateOrganization: true,
    });
    render(
      <SidebarContextSwitcher
        activeProjectId="p1"
        activeOrganizationId="org_a"
        projects={projects}
        onSwitchProject={vi.fn()}
        onCreateProject={vi.fn(async () => "")}
        onDeleteProject={vi.fn()}
        onSwitchActiveOrganization={vi.fn()}
      />
    );
    openMainDropdown();
    openOrgSwitchList();

    const row = screen.getByTestId("org-row-org_b");
    expect(row).toBeInTheDocument();
    expect(row).toHaveAttribute("aria-disabled", "true");
    expect(screen.getByText("Seat not paid yet")).toBeInTheDocument();
  });

  it("clicking a seat-pending org does not switch to it", () => {
    const onSwitchActiveOrganization = vi.fn();
    mockUseOrganizationQueries.mockReturnValue({
      sortedOrganizations: [orgs[0], { ...orgs[1], seatPending: true }],
      isLoading: false,
      createdCount: 0,
      canCreateOrganization: true,
    });
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
    openMainDropdown();
    openOrgSwitchList();

    const row = screen.getByTestId("org-row-org_b");
    // Removed from the tab order too — reachable by keyboard would imply
    // activatable, and it is not.
    expect(row).toHaveAttribute("tabindex", "-1");

    fireEvent.click(row);
    fireEvent.keyDown(row, { key: "Enter" });
    fireEvent.keyDown(row, { key: " " });

    expect(onSwitchActiveOrganization).not.toHaveBeenCalled();
    // The menu stays open — nothing happened.
    expect(screen.getByTestId("org-switch-list")).toBeInTheDocument();
  });

  it("clicking the already-active org in the switch list does not call onSwitchActiveOrganization", () => {
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
    openMainDropdown();
    openOrgSwitchList();
    fireEvent.click(screen.getByTestId("org-row-org_a"));
    expect(onSwitchActiveOrganization).not.toHaveBeenCalled();
  });

  it("clicking the gear icon in an org switch row navigates via onSwitchOrganization", () => {
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
    openMainDropdown();
    openOrgSwitchList();
    const list = screen.getByTestId("org-switch-list");
    fireEvent.click(
      within(list).getByRole("button", { name: "Open Acme settings" })
    );
    expect(onSwitchOrganization).toHaveBeenCalledWith("org_a", "overview");
  });

  it("clicking the footer org row gear opens the active org's settings", () => {
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
    openMainDropdown();
    const footerRow = screen.getByTestId("org-context-row");
    fireEvent.click(
      within(footerRow).getByRole("button", { name: "Open Acme settings" })
    );
    expect(onSwitchOrganization).toHaveBeenCalledWith("org_a", "overview");
  });

  it("renders the gear icon for every org in the switch list regardless of role", () => {
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
    openMainDropdown();
    openOrgSwitchList();
    const list = screen.getByTestId("org-switch-list");
    expect(
      within(list).getByRole("button", { name: "Open Acme settings" })
    ).toBeInTheDocument();
    expect(
      within(list).getByRole("button", { name: "Open Nimbus settings" })
    ).toBeInTheDocument();
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
    openMainDropdown();
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
    openMainDropdown();
    expect(
      screen.getByRole("button", { name: "Open Inspector settings" })
    ).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "Open Sandbox settings" })
    ).toBeInTheDocument();
  });

  it("clicking the per-row gear opens THAT project's settings, with no pre-switch", async () => {
    // The gear used to switch the active project and then navigate. One URL
    // does both now (`/p/<id>/project-settings`), so there is no window in
    // which the app is on project B while the address bar still says A — and
    // no second writer for the route coordinator to race.
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
    openMainDropdown();
    fireEvent.click(
      screen.getByRole("button", { name: "Open Sandbox settings" })
    );
    expect(onSwitchProject).not.toHaveBeenCalled();
    await waitFor(() => {
      // The id is what makes this one gesture: the caller navigates straight
      // to that project's settings rather than to "the active project's".
      expect(onNavigateToSettings).toHaveBeenCalledWith("p2");
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
    openMainDropdown();
    fireEvent.click(
      screen.getByRole("button", { name: "Open Inspector settings" })
    );
    expect(onSwitchProject).not.toHaveBeenCalled();
    expect(onNavigateToSettings).toHaveBeenCalledWith("p1");
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
    openMainDropdown();
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
    openMainDropdown();
    expect(screen.getByTitle("2 more")).toBeInTheDocument();
  });

  it("offers 'New organization' at the bottom of the switch list and opens the create org dialog", () => {
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
    openMainDropdown();
    // Not visible until the switch list is expanded — it's a rare action.
    expect(
      screen.queryByRole("button", { name: "New organization" })
    ).not.toBeInTheDocument();
    openOrgSwitchList();
    fireEvent.click(screen.getByRole("button", { name: "New organization" }));
    expect(mockCreateOrgDialog).toHaveBeenCalled();
    const lastCall = mockCreateOrgDialog.mock.calls.at(-1)?.[0] as {
      open: boolean;
    };
    expect(lastCall.open).toBe(true);
  });

  it("omits the 'New organization' button entirely when the user has reached the creation limit", () => {
    mockUseOrganizationQueries.mockReturnValue({
      sortedOrganizations: orgs,
      isLoading: false,
      createdCount: 2,
      canCreateOrganization: false,
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
    openMainDropdown();
    openOrgSwitchList();
    expect(
      screen.queryByRole("button", { name: "New organization" })
    ).not.toBeInTheDocument();
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
    openMainDropdown();
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
    openMainDropdown();
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
      createdCount: 0,
      canCreateOrganization: true,
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
    openMainDropdown();
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

  it("suppresses the learn more hover card while the menu is open", () => {
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
    // Both open to the right of the same trigger, so they'd otherwise overlap.
    expect(screen.getByTestId("learn-more-projects")).toHaveAttribute(
      "data-suppressed",
      "false"
    );
    openMainDropdown();
    expect(screen.getByTestId("learn-more-projects")).toHaveAttribute(
      "data-suppressed",
      "true"
    );
  });

  it("single org: hides the switch affordance and shows org context plus direct create row", () => {
    mockUseOrganizationQueries.mockReturnValue({
      sortedOrganizations: [orgs[0]],
      isLoading: false,
      createdCount: 0,
      canCreateOrganization: true,
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
    openMainDropdown();
    expect(screen.getAllByText("Inspector").length).toBeGreaterThanOrEqual(1);
    // Nothing to switch to → no switch affordance at all
    expect(screen.queryByTestId("switch-org-button")).not.toBeInTheDocument();
    expect(screen.queryByTestId("org-switch-list")).not.toBeInTheDocument();
    // Org still shown as ambient context in the footer
    expect(
      within(screen.getByTestId("org-context-row")).getByText("Acme")
    ).toBeInTheDocument();
    // With no owned org, create is offered directly in the footer
    expect(
      screen.getByRole("button", { name: "New organization" })
    ).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "Add project" })
    ).toBeInTheDocument();
  });

  it("single org owned by the user: footer has no switch or create affordances", () => {
    mockUseOrganizationQueries.mockReturnValue({
      sortedOrganizations: [orgs[0]],
      isLoading: false,
      createdCount: 1,
      canCreateOrganization: false,
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
    openMainDropdown();
    expect(screen.queryByTestId("switch-org-button")).not.toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "New organization" })
    ).not.toBeInTheDocument();
  });

  it("guest: footer shows a sign-in row that triggers sign in", () => {
    const signIn = vi.fn();
    mockUseAuth.mockReturnValue({ user: null, signIn });
    mockUseConvexAuth.mockReturnValue({
      isAuthenticated: false,
      isLoading: false,
    });
    mockUseOrganizationQueries.mockReturnValue({
      sortedOrganizations: [],
      isLoading: false,
      createdCount: 0,
      canCreateOrganization: true,
    });
    render(
      <SidebarContextSwitcher
        activeProjectId="p1"
        projects={{ p1: { ...projects.p1, organizationId: undefined } }}
        onSwitchProject={vi.fn()}
        onCreateProject={vi.fn(async () => "")}
        onDeleteProject={vi.fn()}
      />
    );
    openMainDropdown();
    // No org context, switch, or create affordances for guests
    expect(screen.queryByTestId("org-context-row")).not.toBeInTheDocument();
    expect(screen.queryByTestId("switch-org-button")).not.toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "New organization" })
    ).not.toBeInTheDocument();
    fireEvent.click(screen.getByTestId("org-sign-in-button"));
    expect(signIn).toHaveBeenCalled();
  });
});
