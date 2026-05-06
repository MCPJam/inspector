import { fireEvent, render, screen } from "@testing-library/react";
import type { ButtonHTMLAttributes, ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { MCPSidebar } from "@/components/mcp-sidebar";

const mockUseConvexAuth = vi.fn();
const mockUseAuth = vi.fn();
const mockShareProjectDialog = vi.fn();
const mockFeatureFlags: Record<string, boolean | undefined> = {};

vi.mock("convex/react", () => ({
  useConvexAuth: (...args: unknown[]) => mockUseConvexAuth(...args),
  useQuery: () => undefined,
}));

vi.mock("@workos-inc/authkit-react", () => ({
  useAuth: (...args: unknown[]) => mockUseAuth(...args),
}));

vi.mock("posthog-js/react", () => ({
  usePostHog: () => ({
    capture: vi.fn(),
  }),
  useFeatureFlagEnabled: (flag: string) => mockFeatureFlags[flag] ?? false,
}));

vi.mock("@/stores/preferences/preferences-provider", () => ({
  usePreferencesStore: (selector: (state: { themeMode: string }) => unknown) =>
    selector({ themeMode: "light" }),
}));

vi.mock("@/hooks/useUpdateNotification", () => ({
  useUpdateNotification: () => ({
    updateReady: false,
    restartAndInstall: vi.fn(),
  }),
}));

vi.mock("@/hooks/use-learn-more", () => ({
  useLearnMore: () => ({
    expandedTabId: null,
    sourceRect: null,
    openExpandedModal: vi.fn(),
    closeExpandedModal: vi.fn(),
  }),
}));

vi.mock("@/components/learn-more/LearnMoreExpandedPanel", () => ({
  LearnMoreExpandedPanel: () => null,
}));

vi.mock("@/components/sidebar/nav-main", () => ({
  NavMain: () => <div data-testid="nav-main" />,
}));

vi.mock("@/components/sidebar/sidebar-user", () => ({
  SidebarUser: () => <div data-testid="sidebar-user" />,
}));

vi.mock("@/components/sidebar/sidebar-context-switcher", () => ({
  SidebarContextSwitcher: () => <div data-testid="context-switcher" />,
}));

vi.mock("@/components/sidebar/sidebar-credit-usage", () => ({
  SidebarCreditUsage: ({
    className,
    includeGuests,
  }: {
    className?: string;
    includeGuests?: boolean;
  }) => (
    <div
      data-testid="sidebar-credit-usage"
      data-include-guests={String(includeGuests)}
      className={className}
    />
  ),
}));

vi.mock("@/components/project/ShareProjectDialog", () => ({
  ShareProjectDialog: (props: unknown) => mockShareProjectDialog(props),
}));

vi.mock("@/components/ui/sidebar", () => ({
  Sidebar: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  SidebarContent: ({ children }: { children: ReactNode }) => (
    <div>{children}</div>
  ),
  SidebarFooter: ({ children }: { children: ReactNode }) => (
    <div>{children}</div>
  ),
  SidebarGroup: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  SidebarGroupContent: ({ children }: { children: ReactNode }) => (
    <div>{children}</div>
  ),
  SidebarHeader: ({ children }: { children: ReactNode }) => (
    <div>{children}</div>
  ),
  SidebarMenu: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  SidebarMenuItem: ({ children }: { children: ReactNode }) => (
    <div>{children}</div>
  ),
  SidebarMenuButton: ({
    children,
    tooltip: _tooltip,
    isActive: _isActive,
    ...props
  }: ButtonHTMLAttributes<HTMLButtonElement> & {
    isActive?: boolean;
    tooltip?: string;
  }) => (
    <button type="button" {...props}>
      {children}
    </button>
  ),
  SidebarMenuSub: ({ children }: { children: ReactNode }) => (
    <div>{children}</div>
  ),
  SidebarMenuSubButton: ({
    children,
    isActive: _isActive,
    ...props
  }: ButtonHTMLAttributes<HTMLButtonElement> & { isActive?: boolean }) => (
    <button type="button" {...props}>
      {children}
    </button>
  ),
  SidebarMenuSubItem: ({ children }: { children: ReactNode }) => (
    <div>{children}</div>
  ),
  SidebarTrigger: () => null,
  useSidebar: () => ({
    isMobile: false,
    state: "expanded",
  }),
}));

vi.mock("@mcpjam/design-system/tooltip", () => ({
  Tooltip: ({ children }: { children: ReactNode }) => <>{children}</>,
  TooltipTrigger: ({ children }: { children: ReactNode }) => <>{children}</>,
  TooltipContent: ({ children }: { children: ReactNode }) => (
    <div>{children}</div>
  ),
}));

function makeProject(id: string, name: string) {
  return {
    id,
    name,
    servers: {},
    createdAt: new Date(),
    updatedAt: new Date(),
    sharedProjectId: id,
    organizationId: "org-1",
    visibility: "public" as const,
  };
}

function renderSidebar(overrides: Partial<React.ComponentProps<typeof MCPSidebar>> = {}) {
  return render(
    <MCPSidebar
      projects={{
        "project-a": makeProject("project-a", "Acme"),
        "project-b": makeProject("project-b", "Beta"),
      }}
      activeProjectId="project-a"
      onSwitchProject={vi.fn()}
      onCreateProject={vi.fn(async () => "project-created")}
      onDeleteProject={vi.fn()}
      onProjectShared={vi.fn()}
      {...overrides}
    />,
  );
}

describe("sidebar invite CTA", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    Object.keys(mockFeatureFlags).forEach((flag) => {
      delete mockFeatureFlags[flag];
    });
    mockUseConvexAuth.mockReturnValue({
      isAuthenticated: true,
      isLoading: false,
    });
    mockUseAuth.mockReturnValue({
      user: {
        email: "owner@example.com",
        firstName: "Owner",
        lastName: "Example",
      },
    });
    mockShareProjectDialog.mockImplementation(
      ({ isOpen, projectName }: { isOpen: boolean; projectName: string }) =>
        isOpen ? (
          <div data-testid="share-project-dialog">
            Share dialog for {projectName}
          </div>
        ) : null,
    );
  });

  it("hides the CTA for guest users", () => {
    mockUseConvexAuth.mockReturnValue({
      isAuthenticated: false,
      isLoading: false,
    });
    mockUseAuth.mockReturnValue({
      user: null,
    });

    renderSidebar();

    expect(
      screen.queryByRole("button", { name: "Invite team members" }),
    ).not.toBeInTheDocument();
  });

  it("shows the CTA for signed-in users and keeps the collapsed text class", () => {
    renderSidebar();

    expect(
      screen.getByRole("button", { name: "Invite team members" }),
    ).toBeInTheDocument();
    expect(screen.getByText("Invite team members")).toHaveClass(
      "group-data-[collapsible=icon]:hidden",
    );
  });

  it("keeps signed-in footer focused on invite CTA and the profile menu", () => {
    renderSidebar();

    const inviteButton = screen.getByRole("button", {
      name: "Invite team members",
    });
    const sidebarUser = screen.getByTestId("sidebar-user");

    expect(screen.queryByTestId("sidebar-credit-usage")).not.toBeInTheDocument();
    expect(
      inviteButton.compareDocumentPosition(sidebarUser) &
        Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
  });

  it("pins credit usage above the account button for guests", () => {
    mockUseConvexAuth.mockReturnValue({
      isAuthenticated: false,
      isLoading: false,
    });
    mockUseAuth.mockReturnValue({
      user: null,
    });

    renderSidebar();

    const creditUsage = screen.getByTestId("sidebar-credit-usage");
    const sidebarUser = screen.getByTestId("sidebar-user");

    expect(creditUsage).toHaveAttribute("data-include-guests", "true");
    expect(creditUsage).toHaveClass("px-1");
    expect(
      creditUsage.compareDocumentPosition(sidebarUser) &
        Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
  });

  it("opens the share dialog for the active project", () => {
    renderSidebar();

    fireEvent.click(screen.getByRole("button", { name: "Invite team members" }));

    expect(screen.getByTestId("share-project-dialog")).toHaveTextContent(
      "Share dialog for Acme",
    );
  });

  it("keeps the CTA visible when the active project changes", () => {
    const { rerender } = renderSidebar();

    rerender(
      <MCPSidebar
        projects={{
          "project-a": makeProject("project-a", "Acme"),
          "project-b": makeProject("project-b", "Beta"),
        }}
        activeProjectId="project-b"
        onSwitchProject={vi.fn()}
        onCreateProject={vi.fn(async () => "project-created")}
        onDeleteProject={vi.fn()}
        onProjectShared={vi.fn()}
      />,
    );

    expect(
      screen.getByRole("button", { name: "Invite team members" }),
    ).toBeInTheDocument();
  });

  it("shows disabled Playground with a beta tooltip when the flag is off", () => {
    mockFeatureFlags["playground-enabled"] = false;
    window.location.hash = "#servers";

    renderSidebar();

    expect(screen.getByRole("button", { name: "Evaluate" })).toHaveAttribute(
      "aria-disabled",
      "true",
    );
    const playground = screen.getByRole("button", { name: "Playground" });
    expect(playground).toHaveAttribute("aria-disabled", "true");
    expect(playground).toHaveClass("cursor-not-allowed");
    expect(
      screen.getByText("Coming soon. Playground is in beta."),
    ).toBeInTheDocument();
    expect(screen.queryByText("Beta")).not.toBeInTheDocument();

    fireEvent.click(playground);

    expect(window.location.hash).toBe("#servers");
  });

  it("enables Playground without a beta badge when the flag is on", () => {
    mockFeatureFlags["playground-enabled"] = true;

    renderSidebar();

    const playground = screen
      .getByText("Playground")
      .closest("button") as HTMLButtonElement;
    expect(playground).toBeInTheDocument();
    expect(playground).not.toHaveAttribute("aria-disabled");
    expect(screen.queryByText("Beta")).not.toBeInTheDocument();
    expect(
      screen.queryByText("Coming soon. Playground is in beta."),
    ).not.toBeInTheDocument();
  });
});
