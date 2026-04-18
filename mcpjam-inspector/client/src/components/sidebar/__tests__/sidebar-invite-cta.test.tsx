import { fireEvent, render, screen } from "@testing-library/react";
import type { ButtonHTMLAttributes, ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { MCPSidebar } from "@/components/mcp-sidebar";

const mockUseConvexAuth = vi.fn();
const mockUseAuth = vi.fn();
const mockShareWorkspaceDialog = vi.fn();

vi.mock("convex/react", () => ({
  useConvexAuth: (...args: unknown[]) => mockUseConvexAuth(...args),
}));

vi.mock("@workos-inc/authkit-react", () => ({
  useAuth: (...args: unknown[]) => mockUseAuth(...args),
}));

vi.mock("posthog-js/react", () => ({
  usePostHog: () => ({
    capture: vi.fn(),
  }),
  useFeatureFlagEnabled: () => false,
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

vi.mock("@/components/sidebar/sidebar-workspace-selector", () => ({
  SidebarWorkspaceSelector: () => <div data-testid="workspace-selector" />,
}));

vi.mock("@/components/workspace/ShareWorkspaceDialog", () => ({
  ShareWorkspaceDialog: (props: unknown) => mockShareWorkspaceDialog(props),
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
    ...props
  }: ButtonHTMLAttributes<HTMLButtonElement> & { tooltip?: string }) => (
    <button type="button" {...props}>
      {children}
    </button>
  ),
  SidebarMenuSub: ({ children }: { children: ReactNode }) => (
    <div>{children}</div>
  ),
  SidebarMenuSubButton: ({
    children,
    ...props
  }: ButtonHTMLAttributes<HTMLButtonElement>) => (
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

function makeWorkspace(id: string, name: string) {
  return {
    id,
    name,
    servers: {},
    createdAt: new Date(),
    updatedAt: new Date(),
    sharedWorkspaceId: id,
    organizationId: "org-1",
    visibility: "public" as const,
  };
}

function renderSidebar(overrides: Partial<React.ComponentProps<typeof MCPSidebar>> = {}) {
  return render(
    <MCPSidebar
      workspaces={{
        "workspace-a": makeWorkspace("workspace-a", "Acme"),
        "workspace-b": makeWorkspace("workspace-b", "Beta"),
      }}
      activeWorkspaceId="workspace-a"
      onSwitchWorkspace={vi.fn()}
      onCreateWorkspace={vi.fn(async () => "workspace-created")}
      onDeleteWorkspace={vi.fn()}
      onWorkspaceShared={vi.fn()}
      {...overrides}
    />,
  );
}

describe("sidebar invite CTA", () => {
  beforeEach(() => {
    vi.clearAllMocks();
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
    mockShareWorkspaceDialog.mockImplementation(
      ({ isOpen, workspaceName }: { isOpen: boolean; workspaceName: string }) =>
        isOpen ? (
          <div data-testid="share-workspace-dialog">
            Share dialog for {workspaceName}
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

  it("opens the share dialog for the active workspace", () => {
    renderSidebar();

    fireEvent.click(screen.getByRole("button", { name: "Invite team members" }));

    expect(screen.getByTestId("share-workspace-dialog")).toHaveTextContent(
      "Share dialog for Acme",
    );
  });

  it("keeps the CTA visible when the active workspace changes", () => {
    const { rerender } = renderSidebar();

    rerender(
      <MCPSidebar
        workspaces={{
          "workspace-a": makeWorkspace("workspace-a", "Acme"),
          "workspace-b": makeWorkspace("workspace-b", "Beta"),
        }}
        activeWorkspaceId="workspace-b"
        onSwitchWorkspace={vi.fn()}
        onCreateWorkspace={vi.fn(async () => "workspace-created")}
        onDeleteWorkspace={vi.fn()}
        onWorkspaceShared={vi.fn()}
      />,
    );

    expect(
      screen.getByRole("button", { name: "Invite team members" }),
    ).toBeInTheDocument();
  });
});
