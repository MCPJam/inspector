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

const mockCreateProjectDialog = vi.fn();
vi.mock("@/components/project/CreateProjectDialog", () => ({
  CreateProjectDialog: (props: { open: boolean; defaultName: string }) => {
    mockCreateProjectDialog(props);
    return props.open ? (
      <div data-testid="create-project-dialog">{props.defaultName}</div>
    ) : null;
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

function openOrgList() {
  fireEvent.click(screen.getByTestId("org-header-button"));
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
    expect(screen.queryByTestId("org-header-button")).not.toBeInTheDocument();
    expect(screen.queryByText("Create project")).not.toBeInTheDocument();
    // Open: clicking the trigger reveals the menu.
    openMainDropdown();
    expect(screen.getByTestId("org-header-button")).toBeInTheDocument();
    expect(screen.getByText("Create project")).toBeInTheDocument();
    // Close: clicking the trigger again hides it.
    openMainDropdown();
    expect(screen.queryByTestId("org-header-button")).not.toBeInTheDocument();
  });

  it("trigger leads with the organization and puts the project beneath it", () => {
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
    // The organization is the broader context, so it is the bold line. Read
    // the other way round, the heading changed every time you switched
    // project inside one organization.
    const trigger = screen.getByRole("button", {
      name: /^Switch context:/,
    });
    const [primary, secondary] = Array.from(trigger.querySelectorAll("span"));
    expect(primary).toHaveTextContent("Acme");
    expect(primary).toHaveClass("font-semibold");
    expect(secondary).toHaveTextContent("Inspector");
    expect(secondary).toHaveClass("text-muted-foreground");
  });

  it("trigger falls back to 'No organization' with no active org", () => {
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
    expect(screen.getByText("No organization")).toBeInTheDocument();
  });

  it("opens on projects: org header, then the project list, then create", () => {
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

    const header = screen.getByTestId("org-header-button");
    expect(header).toHaveTextContent("Acme");
    expect(header).toHaveTextContent("Organization");

    const sandbox = screen.getByText("Sandbox");
    const createRow = screen.getByRole("button", { name: "Create project" });
    expect(
      header.compareDocumentPosition(sandbox) &
        Node.DOCUMENT_POSITION_FOLLOWING
    ).toBeTruthy();
    expect(
      sandbox.compareDocumentPosition(createRow) &
        Node.DOCUMENT_POSITION_FOLLOWING
    ).toBeTruthy();

    // Other orgs' projects are not in this org's list
    expect(screen.queryByText("Nimbus Project")).not.toBeInTheDocument();
    // The organization list is a drill-in, not a second list on this view
    expect(screen.queryByTestId("org-switch-list")).not.toBeInTheDocument();
  });

  it("marks the active project with a check", () => {
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
    expect(screen.getByTestId("project-active-check-p1")).toBeInTheDocument();
    expect(
      screen.queryByTestId("project-active-check-p2")
    ).not.toBeInTheDocument();
  });

  it("the org header drills into the organization list, and the back header returns", () => {
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
    openOrgList();

    // The list REPLACES the projects view rather than pushing it down.
    expect(screen.getByTestId("org-switch-list")).toBeInTheDocument();
    expect(screen.getByTestId("org-row-org_a")).toBeInTheDocument();
    expect(screen.getByTestId("org-row-org_b")).toBeInTheDocument();
    expect(screen.getByTestId("org-list-back-button")).toHaveTextContent(
      "Organizations"
    );
    expect(screen.queryByText("Sandbox")).not.toBeInTheDocument();

    fireEvent.click(screen.getByTestId("org-list-back-button"));
    expect(screen.queryByTestId("org-switch-list")).not.toBeInTheDocument();
    expect(screen.getByText("Sandbox")).toBeInTheDocument();
  });

  it("marks the active organization with a check", () => {
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
    openOrgList();
    expect(screen.getByTestId("org-active-check-org_a")).toBeInTheDocument();
    expect(
      screen.queryByTestId("org-active-check-org_b")
    ).not.toBeInTheDocument();
  });

  it("reopening the menu returns to the projects view", () => {
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
    openOrgList();
    // Close, then reopen: switching orgs is rare, so the common case wins.
    openMainDropdown();
    openMainDropdown();
    expect(screen.queryByTestId("org-switch-list")).not.toBeInTheDocument();
    expect(screen.getByTestId("org-header-button")).toBeInTheDocument();
  });

  it("clicking an org row switches to it, by id alone", () => {
    // One handler, one argument. The row used to write hidden state while a
    // second handler navigated to a settings page; the two disagreed about
    // what "switch organization" meant and the state-only one silently
    // reverted.
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
    openOrgList();
    fireEvent.click(screen.getByTestId("org-row-org_b"));
    expect(onSwitchOrganization).toHaveBeenCalledWith("org_b");
    expect(onSwitchOrganization).toHaveBeenCalledTimes(1);
    // The whole menu closes after switching
    expect(screen.queryByTestId("org-switch-list")).not.toBeInTheDocument();
  });

  it("has no organization gears — the org list only switches", () => {
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
    openOrgList();
    expect(
      screen.queryByRole("button", { name: "Open Acme settings" })
    ).not.toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "Open Nimbus settings" })
    ).not.toBeInTheDocument();
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
        onSwitchOrganization={vi.fn()}
      />
    );
    openMainDropdown();
    openOrgList();

    const row = screen.getByTestId("org-row-org_b");
    expect(row).toBeInTheDocument();
    expect(row).toHaveAttribute("aria-disabled", "true");
    expect(screen.getByText("Seat not paid yet")).toBeInTheDocument();
  });

  it("clicking a seat-pending org does not switch to it", () => {
    const onSwitchOrganization = vi.fn();
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
        onSwitchOrganization={onSwitchOrganization}
      />
    );
    openMainDropdown();
    openOrgList();

    const row = screen.getByTestId("org-row-org_b");
    // Removed from the tab order too — reachable by keyboard would imply
    // activatable, and it is not.
    expect(row).toHaveAttribute("tabindex", "-1");

    fireEvent.click(row);
    fireEvent.keyDown(row, { key: "Enter" });
    fireEvent.keyDown(row, { key: " " });

    expect(onSwitchOrganization).not.toHaveBeenCalled();
    // The menu stays open — nothing happened.
    expect(screen.getByTestId("org-switch-list")).toBeInTheDocument();
  });

  it("clicking the already-active org is a no-op, and closes the menu", () => {
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
    openOrgList();
    fireEvent.click(screen.getByTestId("org-row-org_a"));
    expect(onSwitchOrganization).not.toHaveBeenCalled();
    expect(screen.queryByTestId("org-switch-list")).not.toBeInTheDocument();
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
    // Not visible until you drill into the organization list — it's a rare
    // action, and the projects view is what the menu opens on.
    expect(
      screen.queryByRole("button", { name: "New organization" })
    ).not.toBeInTheDocument();
    openOrgList();
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
    openOrgList();
    expect(
      screen.queryByRole("button", { name: "New organization" })
    ).not.toBeInTheDocument();
  });

  it("clicking 'Add project' opens the dialog prefilled with a free name and the active org", () => {
    // The button used to create a project outright, naming it for you in
    // whichever org happened to be active. It now asks.
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
    fireEvent.click(screen.getByRole("button", { name: "Create project" }));

    expect(onCreateProject).not.toHaveBeenCalled();
    expect(screen.getByTestId("create-project-dialog")).toHaveTextContent(
      "Project"
    );
    const props = mockCreateProjectDialog.mock.calls.at(-1)?.[0];
    expect(props).toMatchObject({
      open: true,
      defaultName: "Project",
      defaultOrganizationId: "org_a",
    });
    expect(props.organizations.map((o: { _id: string }) => o._id)).toEqual([
      "org_a",
      "org_b",
    ]);
  });

  it("skips a taken project name when prefilling the dialog", () => {
    render(
      <SidebarContextSwitcher
        activeProjectId="p1"
        activeOrganizationId="org_a"
        projects={{
          ...projects,
          taken: { ...projects.p1, id: "taken", name: "Project" },
        }}
        onSwitchProject={vi.fn()}
        onCreateProject={vi.fn(async () => "")}
        onDeleteProject={vi.fn()}
      />
    );
    openMainDropdown();
    fireEvent.click(screen.getByRole("button", { name: "Create project" }));

    expect(mockCreateProjectDialog.mock.calls.at(-1)?.[0]).toMatchObject({
      defaultName: "Project 2",
    });
  });

  it("keeps a seat-pending organization out of the create dialog's choices", () => {
    // Every server-side query for a seat-pending org is denied, so a project
    // created in one could not then be opened.
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
      />
    );
    openMainDropdown();
    fireEvent.click(screen.getByRole("button", { name: "Create project" }));

    expect(
      mockCreateProjectDialog.mock.calls
        .at(-1)?.[0]
        .organizations.map((o: { _id: string }) => o._id)
    ).toEqual(["org_a"]);
  });

  it("keeps an organization the viewer cannot create in out of the dialog", () => {
    // A guest has no create permission anywhere in that org, so offering it
    // only produces a server rejection. A per-org project CAP is still not
    // decidable here — that gate is resolved for the active org only.
    mockUseOrganizationQueries.mockReturnValue({
      sortedOrganizations: [orgs[0], { ...orgs[1], myRole: "guest" }],
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
      />
    );
    openMainDropdown();
    fireEvent.click(screen.getByRole("button", { name: "Create project" }));

    expect(
      mockCreateProjectDialog.mock.calls
        .at(-1)?.[0]
        .organizations.map((o: { _id: string }) => o._id)
    ).toEqual(["org_a"]);
  });

  it("confirms before deleting a project from the switcher", async () => {
    // Deleting takes every server in the project. It used to happen on one
    // click of a button that only appears on hover.
    const onDeleteProject = vi.fn();
    render(
      <SidebarContextSwitcher
        activeProjectId="p1"
        activeOrganizationId="org_a"
        projects={projects}
        onSwitchProject={vi.fn()}
        onCreateProject={vi.fn(async () => "")}
        onDeleteProject={onDeleteProject}
      />
    );
    openMainDropdown();
    fireEvent.click(
      screen.getByRole("button", { name: "Delete project Sandbox" })
    );

    expect(onDeleteProject).not.toHaveBeenCalled();
    const dialog = await screen.findByRole("alertdialog");
    expect(dialog).toHaveTextContent("Delete project?");
    expect(dialog).toHaveTextContent("Sandbox");

    fireEvent.click(within(dialog).getByRole("button", { name: "Delete" }));
    expect(onDeleteProject).toHaveBeenCalledWith("p2");
  });

  it("cancelling the delete confirmation leaves the project alone", async () => {
    const onDeleteProject = vi.fn();
    render(
      <SidebarContextSwitcher
        activeProjectId="p1"
        activeOrganizationId="org_a"
        projects={projects}
        onSwitchProject={vi.fn()}
        onCreateProject={vi.fn(async () => "")}
        onDeleteProject={onDeleteProject}
      />
    );
    openMainDropdown();
    fireEvent.click(
      screen.getByRole("button", { name: "Delete project Sandbox" })
    );

    const dialog = await screen.findByRole("alertdialog");
    fireEvent.click(within(dialog).getByRole("button", { name: "Cancel" }));

    await waitFor(() => {
      expect(screen.queryByRole("alertdialog")).not.toBeInTheDocument();
    });
    expect(onDeleteProject).not.toHaveBeenCalled();
  });

  it("disables the Create project row when isCreateDisabled is true", () => {
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
    const button = screen.getByRole("button", { name: "Create project" });
    expect(button).toBeDisabled();
    expect(button).toHaveAttribute(
      "title",
      "Project limit reached. Upgrade to add more."
    );
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

  it("single org: the header still opens a one-row list with New organization", () => {
    // The header is openable whatever the membership count. The list is also
    // where "New organization" lives, and a header that only sometimes
    // responds to a click is worse than one that always shows what you have.
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
    expect(
      screen.getByRole("button", { name: "Create project" })
    ).toBeInTheDocument();

    openOrgList();
    expect(screen.getByTestId("org-row-org_a")).toBeInTheDocument();
    expect(screen.getByTestId("org-active-check-org_a")).toBeInTheDocument();
    expect(screen.queryByTestId("org-row-org_b")).not.toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "New organization" })
    ).toBeInTheDocument();
  });

  it("single org at the creation limit: the list is just that one org", () => {
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
    openOrgList();
    expect(screen.getByTestId("org-row-org_a")).toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "New organization" })
    ).not.toBeInTheDocument();
  });

  it("guest: the org header slot is a sign-in row that triggers sign in", () => {
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
    // The sign-in row takes the org header's slot; there is no organization
    // to drill into and nothing to create one from.
    expect(screen.queryByTestId("org-header-button")).not.toBeInTheDocument();
    expect(screen.queryByTestId("org-switch-list")).not.toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "New organization" })
    ).not.toBeInTheDocument();
    fireEvent.click(screen.getByTestId("org-sign-in-button"));
    expect(signIn).toHaveBeenCalled();
  });
});
