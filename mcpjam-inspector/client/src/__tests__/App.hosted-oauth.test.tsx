import { type ReactNode, useEffect } from "react";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import App from "../App";
import {
  clearHostedOAuthPendingState,
  writeHostedOAuthPendingMarker,
} from "../lib/hosted-oauth-callback";
import {
  clearSandboxSession,
  writeSandboxSession,
} from "../lib/sandbox-session";

const {
  createAppStateMock,
  mockAppBuilderTabMounts,
  mockConvexAuthState,
  mockHandleOAuthCallback,
  mockHostedShellGateState,
  mockOrganizationsTab,
  mockPosthogCapture,
  mockUseAppState,
  mockUseQuery,
  mockWorkOsAuthState,
} = vi.hoisted(() => {
  const createAppStateMock = () => ({
    appState: {
      servers: {},
      selectedServer: undefined,
      selectedMultipleServers: [],
    },
    isLoading: false,
    isLoadingRemoteWorkspaces: false,
    workspaceServers: {},
    connectedOrConnectingServerConfigs: {},
    selectedMCPConfig: null,
    handleConnect: vi.fn(),
    handleDisconnect: vi.fn(),
    handleReconnect: vi.fn(),
    handleUpdate: vi.fn().mockResolvedValue({
      ok: true,
      serverName: "test-server",
    }),
    handleRemoveServer: vi.fn(),
    setSelectedServer: vi.fn(),
    toggleServerSelection: vi.fn(),
    setSelectedMultipleServersToAllServers: vi.fn(),
    workspaces: {},
    activeWorkspaceId: "ws_local",
    handleSwitchWorkspace: vi.fn(),
    handleCreateWorkspace: vi.fn(),
    handleUpdateWorkspace: vi.fn(),
    handleDeleteWorkspace: vi.fn(),
    handleLeaveWorkspace: vi.fn(),
    handleWorkspaceShared: vi.fn(),
    saveServerConfigWithoutConnecting: vi.fn(),
    handleConnectWithTokensFromOAuthFlow: vi.fn(),
    handleRefreshTokensFromOAuthFlow: vi.fn(),
    activeOrganizationId: undefined,
    setActiveOrganizationId: vi.fn(),
  });

  return {
    createAppStateMock,
    mockAppBuilderTabMounts: vi.fn(),
    mockConvexAuthState: {
      isAuthenticated: true,
      isLoading: false,
    },
    mockHandleOAuthCallback: vi.fn(),
    mockHostedShellGateState: {
      value: "ready" as
        | "ready"
        | "auth-loading"
        | "workspace-loading"
        | "logged-out",
    },
    mockOrganizationsTab: vi.fn(() => <div />),
    mockPosthogCapture: vi.fn(),
    mockUseAppState: vi.fn(createAppStateMock),
    mockUseQuery: vi.fn(() => undefined),
    mockWorkOsAuthState: {
      getAccessToken: vi.fn(),
      signIn: vi.fn(),
      user: null as { id: string } | null,
      isLoading: false,
    },
  };
});

vi.mock("convex/react", () => ({
  useConvexAuth: () => mockConvexAuthState,
  useQuery: mockUseQuery,
}));

vi.mock("@workos-inc/authkit-react", () => ({
  useAuth: () => mockWorkOsAuthState,
}));

vi.mock("posthog-js/react", () => ({
  usePostHog: () => ({
    capture: mockPosthogCapture,
  }),
  useFeatureFlagEnabled: () => false,
}));

vi.mock("sonner", () => ({
  toast: {
    error: vi.fn(),
    success: vi.fn(),
  },
}));

vi.mock("../hooks/use-app-state", () => ({
  useAppState: mockUseAppState,
}));

vi.mock("../hooks/useViews", () => ({
  useViewQueries: () => ({ viewsByServer: new Map() }),
  useWorkspaceServers: () => ({ serversById: new Map() }),
}));

vi.mock("../hooks/hosted/use-hosted-api-context", () => ({
  useHostedApiContext: vi.fn(),
}));

vi.mock("../hooks/useElectronOAuth", () => ({
  useElectronOAuth: vi.fn(),
}));

vi.mock("../hooks/useEnsureDbUser", () => ({
  useEnsureDbUser: vi.fn(),
}));

vi.mock("../hooks/usePostHogIdentify", () => ({
  usePostHogIdentify: vi.fn(),
}));

vi.mock("../lib/config", () => ({
  HOSTED_MODE: true,
}));

vi.mock("../lib/theme-utils", () => ({
  getInitialThemeMode: () => "light",
  updateThemeMode: vi.fn(),
  getInitialThemePreset: () => "default",
  updateThemePreset: vi.fn(),
}));

vi.mock("../lib/oauth/mcp-oauth", () => ({
  handleOAuthCallback: mockHandleOAuthCallback,
}));

vi.mock("../components/ServersTab", () => ({
  ServersTab: () => <div>Servers Tab</div>,
}));
vi.mock("../components/ToolsTab", () => ({
  ToolsTab: () => <div />,
}));
vi.mock("../components/ResourcesTab", () => ({
  ResourcesTab: () => <div />,
}));
vi.mock("../components/PromptsTab", () => ({
  PromptsTab: () => <div />,
}));
vi.mock("../components/SkillsTab", () => ({
  SkillsTab: () => <div />,
}));
vi.mock("../components/LearningTab", () => ({
  LearningTab: () => <div />,
}));
vi.mock("../components/TasksTab", () => ({
  TasksTab: () => <div />,
}));
vi.mock("../components/ChatTabV2", () => ({
  ChatTabV2: () => <div />,
}));
vi.mock("../components/EvalsTab", () => ({
  EvalsTab: () => <div />,
}));
vi.mock("../components/CiEvalsTab", () => ({
  CiEvalsTab: () => <div />,
}));
vi.mock("../components/ViewsTab", () => ({
  ViewsTab: () => <div />,
}));
vi.mock("../components/SandboxesTab", () => ({
  SandboxesTab: () => <div>Sandboxes Tab</div>,
}));
vi.mock("../components/SettingsTab", () => ({
  SettingsTab: () => <div />,
}));
vi.mock("../components/client-config/WorkspaceClientConfigSync", () => ({
  WorkspaceClientConfigSync: () => null,
}));
vi.mock("../components/TracingTab", () => ({
  TracingTab: () => <div />,
}));
vi.mock("../components/AuthTab", () => ({
  AuthTab: () => <div />,
}));
vi.mock("../components/OAuthFlowTab", () => ({
  OAuthFlowTab: () => <div />,
}));
vi.mock("../components/ui-playground/AppBuilderTab", () => ({
  AppBuilderTab: ({
    onOnboardingChange,
  }: {
    onOnboardingChange?: (value: boolean) => void;
  }) => {
    useEffect(() => {
      mockAppBuilderTabMounts();
      onOnboardingChange?.(true);
      return () => onOnboardingChange?.(false);
    }, [onOnboardingChange]);

    return (
      <div data-testid="app-builder-tab">
        <button
          type="button"
          onClick={() => onOnboardingChange?.(false)}
        >
          Finish onboarding
        </button>
      </div>
    );
  },
}));
vi.mock("../components/ProfileTab", () => ({
  ProfileTab: () => <div />,
}));
vi.mock("../components/OrganizationsTab", () => ({
  OrganizationsTab: (props: unknown) => mockOrganizationsTab(props),
}));
vi.mock("../components/SupportTab", () => ({
  SupportTab: () => <div />,
}));
vi.mock("../components/oauth/OAuthDebugCallback", () => ({
  default: () => <div />,
}));
vi.mock("../components/mcp-sidebar", () => ({
  MCPSidebar: () => <div data-testid="mcp-sidebar" />,
}));
vi.mock("../components/ui/sidebar", () => ({
  SidebarInset: ({ children }: { children?: ReactNode }) => (
    <div>{children}</div>
  ),
  SidebarProvider: ({ children }: { children?: ReactNode }) => (
    <div>{children}</div>
  ),
}));
vi.mock("../stores/preferences/preferences-provider", () => ({
  PreferencesStoreProvider: ({ children }: { children?: ReactNode }) => (
    <div>{children}</div>
  ),
}));
vi.mock("../components/ui/sonner", () => ({
  Toaster: () => <div />,
}));
vi.mock("../state/app-state-context", () => ({
  AppStateProvider: ({ children }: { children?: ReactNode }) => (
    <div>{children}</div>
  ),
}));
vi.mock("../components/CompletingSignInLoading", () => ({
  default: () => <div />,
}));
vi.mock("../components/LoadingScreen", () => ({
  default: () => <div data-testid="hosted-oauth-loading" />,
}));
vi.mock("../components/Header", () => ({
  Header: () => <div data-testid="app-header" />,
}));
vi.mock("../components/hosted/HostedShellGate", () => ({
  HostedShellGate: ({ children }: { children?: ReactNode }) => (
    <div>{children}</div>
  ),
}));
vi.mock("../components/hosted/hosted-shell-gate-state", () => ({
  resolveHostedShellGateState: () => mockHostedShellGateState.value,
}));
vi.mock("../components/hosted/SharedServerChatPage", () => ({
  SharedServerChatPage: () => <button type="button">Authorize</button>,
  getSharedPathTokenFromLocation: () => null,
}));
vi.mock("../components/hosted/SandboxChatPage", () => ({
  SandboxChatPage: () => <button type="button">Authorize</button>,
  getSandboxPathTokenFromLocation: () => null,
}));

describe("App hosted OAuth callback handling", () => {
  beforeEach(() => {
    clearHostedOAuthPendingState();
    clearSandboxSession();
    localStorage.clear();
    sessionStorage.clear();
    vi.stubGlobal("__APP_VERSION__", "test");
    window.history.replaceState({}, "", "/oauth/callback?code=oauth-code");
    mockUseAppState.mockReset();
    mockUseAppState.mockImplementation(createAppStateMock);
    mockUseQuery.mockReset();
    mockUseQuery.mockImplementation((ref: string) =>
      ref === "users:getCurrentUser" ? null : undefined,
    );
    mockHostedShellGateState.value = "ready";
    mockConvexAuthState.isAuthenticated = true;
    mockConvexAuthState.isLoading = false;
    mockWorkOsAuthState.getAccessToken = vi.fn();
    mockWorkOsAuthState.signIn = vi.fn();
    mockWorkOsAuthState.user = null;
    mockWorkOsAuthState.isLoading = false;
    mockHandleOAuthCallback.mockReset();
    mockOrganizationsTab.mockReset();
    mockOrganizationsTab.mockImplementation(() => <div />);
    mockPosthogCapture.mockReset();
    mockAppBuilderTabMounts.mockReset();
    mockHandleOAuthCallback.mockImplementation(
      () => new Promise<never>(() => {}),
    );

    writeSandboxSession({
      token: "sandbox-token",
      payload: {
        workspaceId: "ws_1",
        sandboxId: "sbx_1",
        name: "Asaan",
        description: "Hosted sandbox",
        hostStyle: "claude",
        mode: "invited_only",
        allowGuestAccess: false,
        viewerIsWorkspaceMember: true,
        systemPrompt: "You are helpful.",
        modelId: "openai/gpt-5-mini",
        temperature: 0.4,
        requireToolApproval: true,
        servers: [
          {
            serverId: "srv_asana",
            serverName: "asana",
            useOAuth: true,
            serverUrl: "https://mcp.asana.com/sse",
            clientId: null,
            oauthScopes: null,
          },
        ],
      },
    });
    writeHostedOAuthPendingMarker({
      surface: "sandbox",
      serverName: "asana",
      serverUrl: "https://mcp.asana.com/sse",
      returnHash: "#asaan",
    });
    localStorage.setItem("mcp-oauth-pending", "asana");
    localStorage.setItem("mcp-serverUrl-asana", "https://mcp.asana.com/sse");
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("shows loading before any hosted authorize CTA can render", async () => {
    render(<App />);

    expect(screen.getByTestId("hosted-oauth-loading")).toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "Authorize" }),
    ).not.toBeInTheDocument();
    await waitFor(() => {
      expect(mockHandleOAuthCallback).toHaveBeenCalledWith("oauth-code");
    });
  });

  it("skips billing queries while a persisted org id is still being validated", () => {
    mockUseAppState.mockImplementation(() => ({
      ...createAppStateMock(),
      activeOrganizationId: "stale-org",
    }));

    render(<App />);

    const entitlementsCall = mockUseQuery.mock.calls.find(
      ([name]) => name === "billing:getOrganizationEntitlements",
    );
    const rolloutCall = mockUseQuery.mock.calls.find(
      ([name]) => name === "billing:getBillingRolloutState",
    );

    expect(entitlementsCall?.[1]).toBe("skip");
    expect(rolloutCall?.[1]).toBe("skip");
  });

  it("skips billing queries while a workspace org id is still unvalidated", () => {
    mockUseAppState.mockImplementation(() => ({
      ...createAppStateMock(),
      workspaces: {
        ws_local: {
          id: "ws_local",
          name: "Shared workspace",
          organizationId: "workspace-org",
          servers: {},
          createdAt: new Date(),
          updatedAt: new Date(),
        },
      },
    }));

    render(<App />);

    const entitlementsCall = mockUseQuery.mock.calls.find(
      ([name]) => name === "billing:getOrganizationEntitlements",
    );
    const rolloutCall = mockUseQuery.mock.calls.find(
      ([name]) => name === "billing:getBillingRolloutState",
    );

    expect(entitlementsCall?.[1]).toBe("skip");
    expect(rolloutCall?.[1]).toBe("skip");
  });

  it("does not auto-select the first organization without an explicit org route", async () => {
    const setActiveOrganizationId = vi.fn();
    mockUseAppState.mockImplementation(() => ({
      ...createAppStateMock(),
      setActiveOrganizationId,
    }));
    mockUseQuery.mockImplementation((name: string) => {
      if (name === "organizations:getMyOrganizations") {
        return [
          {
            _id: "org-recent",
            name: "Recent Org",
            updatedAt: 2,
            createdAt: 1,
            createdBy: "user-1",
          },
          {
            _id: "org-older",
            name: "Older Org",
            updatedAt: 1,
            createdAt: 1,
            createdBy: "user-1",
          },
        ];
      }

      return undefined;
    });

    render(<App />);

    await waitFor(() => {
      expect(mockHandleOAuthCallback).toHaveBeenCalledWith("oauth-code");
    });

    expect(setActiveOrganizationId).not.toHaveBeenCalled();
  });

  it("renders the organization route from the hash even before active org state catches up", async () => {
    clearHostedOAuthPendingState();
    clearSandboxSession();
    window.history.replaceState({}, "", "/#organizations/org-1");
    mockUseAppState.mockImplementation(() => ({
      ...createAppStateMock(),
      activeOrganizationId: undefined,
    }));
    mockUseQuery.mockImplementation((name: string) => {
      if (name === "organizations:getMyOrganizations") {
        return [
          {
            _id: "org-1",
            name: "Org One",
            updatedAt: 1,
            createdAt: 1,
            createdBy: "user-1",
            myRole: "owner",
          },
        ];
      }

      return undefined;
    });

    render(<App />);

    await waitFor(() => {
      expect(mockOrganizationsTab).toHaveBeenCalled();
    });

    const lastCall =
      mockOrganizationsTab.mock.calls[
        mockOrganizationsTab.mock.calls.length - 1
      ];
    expect(lastCall?.[0]).toMatchObject({
      organizationId: "org-1",
      section: "overview",
    });
  });

  it("navigates back to the sandboxes tab after callback completion", async () => {
    clearHostedOAuthPendingState();
    clearSandboxSession();
    writeHostedOAuthPendingMarker({
      surface: "sandbox",
      serverName: "asana",
      serverUrl: "https://mcp.asana.com/sse",
      returnHash: "#sandboxes",
    });
    mockHandleOAuthCallback.mockResolvedValue({
      success: true,
      serverName: "asana",
      serverConfig: {
        url: "https://mcp.asana.com/sse",
        requestInit: { headers: { Authorization: "Bearer token" } },
      },
    });

    render(<App />);

    await waitFor(() => {
      expect(window.location.hash).toBe("#sandboxes");
      expect(screen.getByText("Sandboxes Tab")).toBeInTheDocument();
    });
    expect(screen.queryByText("Servers Tab")).not.toBeInTheDocument();
  });

  it("keeps App Builder mounted when onboarding chrome is restored", async () => {
    clearHostedOAuthPendingState();
    clearSandboxSession();
    window.history.replaceState({}, "", "/#app-builder");
    mockHandleOAuthCallback.mockReset();

    render(<App />);

    await waitFor(() => {
      expect(screen.getByTestId("app-builder-tab")).toBeInTheDocument();
    });

    await waitFor(() => {
      expect(screen.queryByTestId("mcp-sidebar")).not.toBeInTheDocument();
      expect(screen.queryByTestId("app-header")).not.toBeInTheDocument();
    });

    expect(mockAppBuilderTabMounts).toHaveBeenCalledTimes(1);

    fireEvent.click(screen.getByRole("button", { name: "Finish onboarding" }));

    await waitFor(() => {
      expect(screen.getByTestId("mcp-sidebar")).toBeInTheDocument();
      expect(screen.getByTestId("app-header")).toBeInTheDocument();
    });

    expect(mockAppBuilderTabMounts).toHaveBeenCalledTimes(1);
  });

  it("restores chrome after leaving App Builder mid-onboarding", async () => {
    clearHostedOAuthPendingState();
    clearSandboxSession();
    window.history.replaceState({}, "", "/#app-builder");
    mockHandleOAuthCallback.mockReset();

    render(<App />);

    await waitFor(() => {
      expect(screen.getByTestId("app-builder-tab")).toBeInTheDocument();
    });

    await waitFor(() => {
      expect(screen.queryByTestId("mcp-sidebar")).not.toBeInTheDocument();
      expect(screen.queryByTestId("app-header")).not.toBeInTheDocument();
    });

    window.location.hash = "servers";
    window.dispatchEvent(new Event("hashchange"));

    await waitFor(() => {
      expect(screen.getByText("Servers Tab")).toBeInTheDocument();
      expect(screen.getByTestId("mcp-sidebar")).toBeInTheDocument();
      expect(screen.getByTestId("app-header")).toBeInTheDocument();
    });

    expect(screen.queryByTestId("app-builder-tab")).not.toBeInTheDocument();
  });

  it("does not auto-route to App Builder when any saved server already exists", async () => {
    clearHostedOAuthPendingState();
    clearSandboxSession();
    window.history.replaceState({}, "", "/#servers");
    mockHandleOAuthCallback.mockReset();
    mockUseAppState.mockImplementation(() => ({
      ...createAppStateMock(),
      workspaceServers: {
        savedServer: {
          name: "savedServer",
          connectionStatus: "disconnected",
          enabled: true,
          retryCount: 0,
          lastConnectionTime: new Date("2026-01-01T00:00:00.000Z"),
          config: {
            transportType: "http",
            url: "https://example.com/mcp",
          },
        },
      },
    }));

    render(<App />);

    await waitFor(() => {
      expect(screen.getByText("Servers Tab")).toBeInTheDocument();
    });

    expect(window.location.hash).toBe("#servers");
    expect(screen.queryByTestId("app-builder-tab")).not.toBeInTheDocument();
  });

  it("does not auto-route to App Builder while the hosted shell is still auth-loading", async () => {
    clearHostedOAuthPendingState();
    clearSandboxSession();
    window.history.replaceState({}, "", "/#servers");
    mockHandleOAuthCallback.mockReset();
    mockHostedShellGateState.value = "auth-loading";

    render(<App />);

    await waitFor(() => {
      expect(screen.getByText("Servers Tab")).toBeInTheDocument();
    });

    expect(window.location.hash).toBe("#servers");
    expect(screen.queryByTestId("app-builder-tab")).not.toBeInTheDocument();
  });

  it("does not auto-route to App Builder until the signed-in user record resolves", async () => {
    clearHostedOAuthPendingState();
    clearSandboxSession();
    window.history.replaceState({}, "", "/#servers");
    mockHandleOAuthCallback.mockReset();
    mockUseQuery.mockImplementation((ref: string) =>
      ref === "users:getCurrentUser" ? undefined : undefined,
    );

    render(<App />);

    await waitFor(() => {
      expect(screen.getByText("Servers Tab")).toBeInTheDocument();
    });

    expect(window.location.hash).toBe("#servers");
    expect(screen.queryByTestId("app-builder-tab")).not.toBeInTheDocument();
  });

  it("does not auto-route to App Builder when onboarding is already completed remotely", async () => {
    clearHostedOAuthPendingState();
    clearSandboxSession();
    window.history.replaceState({}, "", "/#servers");
    mockHandleOAuthCallback.mockReset();
    mockUseQuery.mockImplementation((ref: string) =>
      ref === "users:getCurrentUser"
        ? { _id: "user-1", hasCompletedOnboarding: true }
        : undefined,
    );

    render(<App />);

    await waitFor(() => {
      expect(screen.getByText("Servers Tab")).toBeInTheDocument();
    });

    expect(window.location.hash).toBe("#servers");
    expect(screen.queryByTestId("app-builder-tab")).not.toBeInTheDocument();
  });

  it("still auto-routes a true hosted guest into App Builder onboarding once startup is ready", async () => {
    clearHostedOAuthPendingState();
    clearSandboxSession();
    window.history.replaceState({}, "", "/#servers");
    mockHandleOAuthCallback.mockReset();
    mockConvexAuthState.isAuthenticated = false;

    render(<App />);

    await waitFor(() => {
      expect(screen.getByTestId("app-builder-tab")).toBeInTheDocument();
    });

    expect(window.location.hash).toBe("#app-builder");
  });
});
