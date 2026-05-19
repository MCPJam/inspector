import { type ReactNode, useLayoutEffect, useState } from "react";
import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import App from "../App";
import {
  clearHostedOAuthPendingState,
  writeHostedOAuthPendingMarker,
} from "../lib/hosted-oauth-callback";
import {
  readHostedOAuthResumeMarker,
  writeHostedOAuthResumeMarker,
} from "../lib/hosted-oauth-resume";
import {
  readBillingSignInReturnPath,
  readPersistedCheckoutIntent,
  persistCheckoutIntent,
  writeBillingSignInReturnPath,
} from "../lib/billing-deep-link";
import {
  clearChatboxSession,
  readChatboxSignInReturnPath,
  writeChatboxSignInReturnPath,
  writeChatboxSession,
} from "../lib/chatbox-session";

const existingConvexUser = {
  _id: "user-1",
  externalId: "workos-user-1",
  email: "user@example.com",
  name: "Test User",
  imageUrl: "",
  plan: "free",
  entitlements: {},
  hasSeenOnboarding: true,
  createdAt: 1,
  updatedAt: 1,
};

const {
  createAppStateMock,
  mockAppBuilderTabMounts,
  mockAppBuilderTabProps,
  mockConvexAuthState,
  mockCompleteHostedOAuthCallback,
  mockHandleOAuthCallback,
  mockHeader,
  mockHostedShellGateState,
  mockMCPSidebar,
  mockOAuthFlowTabState,
  mockOrganizationsTab,
  mockPosthogCapture,
  mockPosthogState,
  mockChatboxesTab,
  mockGetGuestBearerToken,
  mockUseAuth,
  mockUseAppState,
  mockUseConvexAuth,
  mockUseFeatureFlagEnabled,
  mockUseQuery,
  mockWorkOsAuthState,
} = vi.hoisted(() => {
  const featureFlagListeners = new Set<() => void>();
  const createAppStateMock = () => ({
    appState: {
      servers: {},
      selectedServer: undefined,
      selectedMultipleServers: [],
    },
    isLoading: false,
    isLoadingRemoteProjects: false,
    projectServers: {},
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
    projects: {},
    activeProjectId: "ws_local",
    handleSwitchProject: vi.fn(),
    handleCreateProject: vi.fn(),
    handleUpdateProject: vi.fn(),
    handleDeleteProject: vi.fn(),
    handleLeaveProject: vi.fn(),
    handleProjectShared: vi.fn(),
    saveServerConfigWithoutConnecting: vi.fn(),
    handleConnectWithTokensFromOAuthFlow: vi.fn(),
    handleRefreshTokensFromOAuthFlow: vi.fn(),
    activeOrganizationId: undefined,
    setActiveOrganizationId: vi.fn(),
    clearConvexActiveProjectSelection: vi.fn(),
    clearLocalFallbackProjectSelection: vi.fn(),
    isCloudSyncActive: false,
  });

  return {
    createAppStateMock,
    mockAppBuilderTabMounts: vi.fn(),
    mockAppBuilderTabProps: vi.fn(),
    mockConvexAuthState: {
      isAuthenticated: true,
      isLoading: false,
    },
    mockCompleteHostedOAuthCallback: vi.fn(),
    mockHandleOAuthCallback: vi.fn(),
    mockHostedShellGateState: {
      value: "ready" as
        | "ready"
        | "auth-loading"
        | "project-loading"
        | "logged-out",
    },
    mockMCPSidebar: vi.fn(() => <div />),
    mockOAuthFlowTabState: {
      shouldThrow: false,
      error: new Error("OAuth debugger failed"),
    },
    mockOrganizationsTab: vi.fn(() => <div />),
    mockPosthogCapture: vi.fn(),
    mockPosthogState: {
      featureFlags: {
        hasLoadedFlags: true,
      },
      onFeatureFlags: vi.fn((callback: () => void) => {
        featureFlagListeners.add(callback);
        return () => featureFlagListeners.delete(callback);
      }),
      emitFeatureFlags: () => {
        for (const callback of Array.from(featureFlagListeners)) {
          callback();
        }
      },
      reset: () => {
        featureFlagListeners.clear();
      },
    },
    mockGetGuestBearerToken: vi.fn(),
    mockUseAuth: vi.fn(),
    mockUseAppState: vi.fn(createAppStateMock),
    mockUseConvexAuth: vi.fn(),
    mockUseFeatureFlagEnabled: vi.fn(),
    mockUseQuery: vi.fn() as unknown as ReturnType<typeof vi.fn>,
    mockChatboxesTab: vi.fn(() => <div>Chatboxes Tab</div>),
    mockHeader: vi.fn((_props: unknown) => <div data-testid="app-header" />),
    mockWorkOsAuthState: {
      getAccessToken: vi.fn(),
      signIn: vi.fn(),
      user: null as { id: string } | null,
      isLoading: false,
    },
  };
});

function mockFreshGuestUser() {
  mockUseQuery.mockImplementation((ref: string) =>
    ref === "users:getCurrentUser"
      ? {
          ...existingConvexUser,
          _id: "guest-1",
          externalId: "guest-1",
          email: "guest@example.com",
          isAnonymous: true,
          // Fresh guest cookie/user rows have not seen first-run NUX yet.
          hasSeenOnboarding: false,
        }
      : undefined
  );
}

function mockSeenGuestUser() {
  mockUseQuery.mockImplementation((ref: string) =>
    ref === "users:getCurrentUser"
      ? {
          ...existingConvexUser,
          _id: "guest-seen-1",
          externalId: "guest-seen-1",
          email: "guest-seen@example.com",
          isAnonymous: true,
          hasSeenOnboarding: true,
        }
      : undefined
  );
}

function mockUnseenOnboardingState() {
  localStorage.removeItem("mcp-onboarding-state");
}

vi.mock("convex/react", () => ({
  useConvexAuth: (...args: unknown[]) => mockUseConvexAuth(...args),
  useQuery: (ref: string, ...args: unknown[]) => {
    const result = mockUseQuery(ref, ...args);
    if (ref === "users:getCurrentUser" && result === undefined) {
      return existingConvexUser;
    }
    return result;
  },
  // Hooks like useChatboxBackfillForProject call the returned mutation as
  // a thenable; return a resolved promise so `.catch(...)` doesn't crash.
  useMutation: () => vi.fn(() => Promise.resolve(undefined)),
  useAction: () => vi.fn(() => Promise.resolve(undefined)),
  // Local-state-migration hook calls useConvex().query for the post-migration
  // OAuth-token import path; the App test never reaches that path (HOSTED_MODE
  // gate exits early), but the hook still calls useConvex() unconditionally.
  useConvex: () => ({ query: vi.fn() }),
}));

vi.mock("@workos-inc/authkit-react", () => ({
  useAuth: (...args: unknown[]) => mockUseAuth(...args),
}));

vi.mock("posthog-js/react", () => ({
  usePostHog: () => ({
    capture: mockPosthogCapture,
    featureFlags: mockPosthogState.featureFlags,
    onFeatureFlags: mockPosthogState.onFeatureFlags,
  }),
  useFeatureFlagEnabled: (...args: unknown[]) =>
    mockUseFeatureFlagEnabled(...args),
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
  useProjectServers: () => ({ serversById: new Map() }),
}));

vi.mock("../hooks/hosted/use-hosted-api-context", () => ({
  useApiContext: vi.fn(),
}));

vi.mock("../hooks/useElectronOAuth", () => ({
  useElectronOAuth: vi.fn(),
}));

vi.mock("../hooks/useEnsureDbUser", () => ({
  useEnsureDbUser: vi.fn(() => ({ isEnsuringUser: false, isUserReady: true })),
}));

vi.mock("../hooks/usePostHogIdentify", () => ({
  usePostHogIdentify: vi.fn(),
}));

vi.mock("../lib/config", () => ({
  HOSTED_MODE: true,
  NON_PROD_LOCKDOWN: false,
}));

vi.mock("../lib/theme-utils", () => ({
  getInitialThemeMode: () => "light",
  updateThemeMode: vi.fn(),
  getInitialThemePreset: () => "default",
  updateThemePreset: vi.fn(),
}));

vi.mock("../lib/oauth/mcp-oauth", () => ({
  completeHostedOAuthCallback: mockCompleteHostedOAuthCallback,
  handleOAuthCallback: mockHandleOAuthCallback,
  isElectronMcpCallbackState: (state: string | null | undefined) =>
    Boolean(state?.startsWith("electron_mcp:")),
}));

vi.mock("../lib/guest-session", () => ({
  clearGuestSession: vi.fn(() => {
    localStorage.removeItem("mcpjam_guest_session_v1");
  }),
  getGuestBearerToken: mockGetGuestBearerToken,
  getCachedGuestSession: vi.fn(() => null),
  getOrCreateGuestSession: vi.fn(async () => null),
  subscribeGuestSessionChanges: vi.fn(() => () => {}),
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
  EvalsTab: () => <div data-testid="evals-tab">Evals Tab</div>,
}));
vi.mock("../components/CiEvalsTab", () => ({
  CiEvalsTab: () => <div data-testid="ci-evals-tab">CI Evals Tab</div>,
}));
vi.mock("../components/ViewsTab", () => ({
  ViewsTab: () => <div />,
}));
vi.mock("../components/ChatboxesTab", () => ({
  ChatboxesTab: (props: unknown) => mockChatboxesTab(props),
}));
vi.mock("../components/SettingsTab", () => ({
  SettingsTab: () => <div />,
}));
vi.mock("../components/client-config/ProjectClientConfigSync", () => ({
  ProjectClientConfigSync: () => null,
}));
vi.mock("../components/TracingTab", () => ({
  TracingTab: () => <div />,
}));
vi.mock("../components/AuthTab", () => ({
  AuthTab: () => <div />,
}));
vi.mock("../components/OAuthFlowTab", () => ({
  OAuthFlowTab: () => {
    if (mockOAuthFlowTabState.shouldThrow) {
      throw mockOAuthFlowTabState.error;
    }
    return <div data-testid="oauth-flow-tab" />;
  },
}));
vi.mock("../components/xaa/XAAFlowTab", () => ({
  XAAFlowTab: () => <div data-testid="xaa-flow-tab">XAA Debugger Tab</div>,
}));
vi.mock("../components/ui-playground/AppBuilderTab", () => ({
  AppBuilderTab: (props: {
    onOnboardingChange?: (value: boolean) => void;
    isSignedInWithWorkOs?: boolean;
    isWorkOsAuthLoading?: boolean;
    isConvexAuthenticated?: boolean;
    hasSeenFirstRunOnboarding?: boolean;
  }) => {
    mockAppBuilderTabProps(props);
    const { onOnboardingChange } = props;

    useLayoutEffect(() => {
      mockAppBuilderTabMounts();
      onOnboardingChange?.(true);
      return () => onOnboardingChange?.(false);
    }, [onOnboardingChange]);

    return (
      <div data-testid="app-builder-tab">
        <button type="button" onClick={() => onOnboardingChange?.(false)}>
          Finish onboarding
        </button>
      </div>
    );
  },
}));
vi.mock("../components/ProfileTab", () => ({
  ProfileTab: () => <div />,
}));
vi.mock("../components/billing/BillingUpsellGate", () => ({
  BillingUpsellGate: ({ feature }: { feature: string }) => (
    <div data-testid="billing-upsell-gate">{feature}</div>
  ),
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
  MCPSidebar: (props: unknown) => mockMCPSidebar(props),
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
  usePreferencesStore: () => true,
}));
// Reconciler is App-internal plumbing; mock it out so the test doesn't
// have to thread shared-app-state + preferences mocks deep enough to
// satisfy `useAutoConnectProjectServers`.
vi.mock("../components/ActiveClientServerReconciler", () => ({
  ActiveClientServerReconciler: () => null,
}));
vi.mock("@mcpjam/design-system/sonner", () => ({
  Toaster: () => <div />,
}));
vi.mock("../state/app-state-context", () => ({
  AppStateProvider: ({ children }: { children?: ReactNode }) => (
    <div>{children}</div>
  ),
  // ActiveClientServerReconciler reads this via useAutoConnectProjectServers
  // to compute connected/excess servers. Return an empty servers map so
  // the reconciler's reconciliation logic is a no-op in App-level tests.
  useSharedAppState: () => ({ servers: {} }),
  useOptionalSharedAppState: () => ({ servers: {} }),
}));
vi.mock("../components/CompletingSignInLoading", () => ({
  default: () => <div />,
}));
vi.mock("../components/LoadingScreen", () => ({
  default: () => <div data-testid="hosted-oauth-loading" />,
}));
vi.mock("../components/Header", () => ({
  Header: (props: unknown) => mockHeader(props),
}));
vi.mock("../components/hosted/HostedShellGate", () => ({
  HostedShellGate: ({ children }: { children?: ReactNode }) => (
    <div>{children}</div>
  ),
}));
vi.mock("../components/hosted/hosted-shell-gate-state", () => ({
  resolveHostedShellGateState: () => mockHostedShellGateState.value,
}));
vi.mock("../components/hosted/ChatboxChatPage", () => ({
  ChatboxChatPage: () => <button type="button">Authorize</button>,
  getChatboxPathTokenFromLocation: () => null,
}));

describe("App hosted OAuth callback handling", () => {
  beforeEach(() => {
    clearHostedOAuthPendingState();
    clearChatboxSession();
    localStorage.clear();
    localStorage.setItem(
      "mcp-onboarding-state",
      JSON.stringify({ status: "completed", completedAt: Date.now() })
    );
    sessionStorage.clear();
    vi.stubGlobal("__APP_VERSION__", "test");
    window.history.replaceState({}, "", "/oauth/callback?code=oauth-code");
    mockUseAuth.mockReset();
    mockUseAuth.mockReturnValue(mockWorkOsAuthState);
    mockUseAppState.mockReset();
    mockUseAppState.mockImplementation(createAppStateMock);
    mockUseConvexAuth.mockReset();
    mockUseConvexAuth.mockReturnValue(mockConvexAuthState);
    mockPosthogState.featureFlags.hasLoadedFlags = true;
    mockPosthogState.onFeatureFlags.mockClear();
    mockPosthogState.reset();
    mockUseFeatureFlagEnabled.mockReset();
    mockUseFeatureFlagEnabled.mockReturnValue(false);
    mockUseQuery.mockReset();
    mockUseQuery.mockImplementation((ref: string) =>
      ref === "users:getCurrentUser" ? existingConvexUser : undefined
    );
    mockHostedShellGateState.value = "ready";
    mockConvexAuthState.isAuthenticated = true;
    mockConvexAuthState.isLoading = false;
    mockWorkOsAuthState.getAccessToken = vi.fn();
    mockWorkOsAuthState.signIn = vi.fn();
    mockWorkOsAuthState.user = null;
    mockWorkOsAuthState.isLoading = false;
    mockCompleteHostedOAuthCallback.mockReset();
    mockHandleOAuthCallback.mockReset();
    mockGetGuestBearerToken.mockReset();
    mockGetGuestBearerToken.mockResolvedValue("guest-bearer");
    mockOrganizationsTab.mockReset();
    mockOrganizationsTab.mockImplementation(() => <div />);
    mockChatboxesTab.mockReset();
    mockChatboxesTab.mockImplementation(() => <div>Chatboxes Tab</div>);
    mockHeader.mockReset();
    mockHeader.mockImplementation((_props: unknown) => (
      <div data-testid="app-header" />
    ));
    mockMCPSidebar.mockReset();
    mockMCPSidebar.mockImplementation(() => <div data-testid="mcp-sidebar" />);
    mockOAuthFlowTabState.shouldThrow = false;
    mockOAuthFlowTabState.error = new Error("OAuth debugger failed");
    mockPosthogCapture.mockReset();
    mockAppBuilderTabMounts.mockReset();
    mockAppBuilderTabProps.mockReset();
    mockCompleteHostedOAuthCallback.mockImplementation(
      () => new Promise<never>(() => {})
    );
    mockHandleOAuthCallback.mockImplementation(
      () => new Promise<never>(() => {})
    );

    writeChatboxSession({
      chatboxId: "sbx_1",
      accessVersion: 1,
      payload: {
        projectId: "ws_1",
        chatboxId: "sbx_1",
        name: "Asaan",
        description: "Hosted chatbox",
        hostStyle: "claude",
        mode: "invited_only",
        allowGuestAccess: false,
        viewerIsProjectMember: true,
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
      surface: "chatbox",
      projectId: "ws_1",
      serverId: "srv_asana",
      sessionId: "hosted-session-1",
      accessScope: "chat_v2",
      chatboxId: "sbx_1",
      accessVersion: 1,
      serverName: "asana",
      serverUrl: "https://mcp.asana.com/sse",
      returnPath: "#asaan",
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
      screen.queryByRole("button", { name: "Authorize" })
    ).not.toBeInTheDocument();
    await waitFor(() => {
      expect(mockCompleteHostedOAuthCallback).toHaveBeenCalledWith(
        expect.objectContaining({
          surface: "chatbox",
          serverName: "asana",
        }),
        "oauth-code",
        expect.objectContaining({
          onTraceUpdate: expect.any(Function),
        })
      );
    });
  });

  it("captures and copies sanitized OAuth Debugger boundary errors", async () => {
    clearHostedOAuthPendingState();
    clearChatboxSession();
    localStorage.clear();
    sessionStorage.clear();
    window.history.replaceState({}, "", "/oauth-flow");
    mockOAuthFlowTabState.shouldThrow = true;
    mockOAuthFlowTabState.error = new Error(
      "token exchange failed client_secret=super-secret Bearer access-token"
    );
    const writeText = vi.fn().mockResolvedValue(undefined);
    vi.stubGlobal("navigator", {
      ...window.navigator,
      clipboard: { writeText },
    });

    render(<App />);

    expect(
      await screen.findByText("OAuth Debugger crashed")
    ).toBeInTheDocument();
    expect(mockPosthogCapture).toHaveBeenCalledWith(
      "oauth_debugger_error_boundary",
      expect.objectContaining({
        message: expect.stringContaining("[redacted]"),
      })
    );
    expect(JSON.stringify(mockPosthogCapture.mock.calls)).not.toContain(
      "super-secret"
    );

    fireEvent.click(screen.getByRole("button", { name: /copy details/i }));

    await waitFor(() => {
      expect(writeText).toHaveBeenCalledWith(
        expect.not.stringContaining("super-secret")
      );
    });
    expect(writeText.mock.calls[0]?.[0]).toContain("[redacted]");
  });

  it("uses hosted completion for guest chatbox session callbacks", async () => {
    mockConvexAuthState.isAuthenticated = false;

    render(<App />);

    await waitFor(() => {
      expect(mockHandleOAuthCallback).not.toHaveBeenCalled();
      expect(mockCompleteHostedOAuthCallback).toHaveBeenCalledWith(
        expect.objectContaining({
          surface: "chatbox",
          projectId: "ws_1",
          serverId: "srv_asana",
          sessionId: "hosted-session-1",
          chatboxId: "sbx_1",
        }),
        "oauth-code",
        expect.objectContaining({
          authorizationHeader: "Bearer guest-bearer",
          onTraceUpdate: expect.any(Function),
        })
      );
    });
  });

  it("uses hosted completion for authenticated chatbox callbacks without a hosted session id", async () => {
    clearHostedOAuthPendingState();
    writeHostedOAuthPendingMarker({
      surface: "chatbox",
      projectId: "ws_1",
      serverId: "srv_asana",
      accessScope: "chat_v2",
      chatboxId: "sbx_1",
      accessVersion: 1,
      serverName: "asana",
      serverUrl: "https://mcp.asana.com/sse",
      returnPath: "#asaan",
    });
    localStorage.setItem("mcp-oauth-pending", "asana");
    localStorage.setItem("mcp-serverUrl-asana", "https://mcp.asana.com/sse");

    render(<App />);

    await waitFor(() => {
      expect(mockHandleOAuthCallback).not.toHaveBeenCalled();
      expect(mockCompleteHostedOAuthCallback).toHaveBeenCalledWith(
        expect.objectContaining({
          surface: "chatbox",
          projectId: "ws_1",
          serverId: "srv_asana",
          sessionId: null,
          chatboxId: "sbx_1",
        }),
        "oauth-code",
        expect.objectContaining({
          authorizationHeader: undefined,
          onTraceUpdate: expect.any(Function),
        })
      );
    });
  });

  it("reports a clear guest session error when a chatbox callback bearer is unavailable", async () => {
    mockConvexAuthState.isAuthenticated = false;
    mockGetGuestBearerToken.mockResolvedValue(null);

    render(<App />);

    await waitFor(() => {
      expect(readHostedOAuthResumeMarker("chatbox")?.errorMessage).toBe(
        "Your guest session expired. Reopen the chatbox link and try again."
      );
    });
    expect(mockCompleteHostedOAuthCallback).not.toHaveBeenCalled();
    expect(mockHandleOAuthCallback).not.toHaveBeenCalled();
  });

  it("attaches the WorkOS bearer when a signed-in user returns to a chatbox callback", async () => {
    // Regression for the chatbox OAuth 403: on chatbox routes useApiContext is
    // gated off, so authFetch's default header resolver demoted signed-in
    // users to guest bearers. The fix explicitly fetches the WorkOS access
    // token and passes it as authorizationHeader, bypassing apiContext.
    mockConvexAuthState.isAuthenticated = true;
    mockWorkOsAuthState.user = { id: "user-workos-1" };
    mockWorkOsAuthState.getAccessToken = vi
      .fn()
      .mockResolvedValue("workos-token");

    render(<App />);

    await waitFor(() => {
      expect(mockCompleteHostedOAuthCallback).toHaveBeenCalledWith(
        expect.objectContaining({
          surface: "chatbox",
          chatboxId: "sbx_1",
        }),
        "oauth-code",
        expect.objectContaining({
          authorizationHeader: "Bearer workos-token",
          onTraceUpdate: expect.any(Function),
        })
      );
    });
    expect(mockGetGuestBearerToken).not.toHaveBeenCalled();
  });

  it("does not keep the hosted loading screen for project OAuth callbacks", async () => {
    clearHostedOAuthPendingState();
    clearChatboxSession();
    writeHostedOAuthPendingMarker({
      surface: "project",
      projectId: "ws_1",
      serverId: "srv_asana",
      serverName: "asana",
      serverUrl: "https://mcp.asana.com/sse",
      accessScope: "project_member",
      returnPath: "#servers",
    });
    localStorage.setItem("mcp-oauth-pending", "asana");
    localStorage.setItem("mcp-serverUrl-asana", "https://mcp.asana.com/sse");

    render(<App />);

    expect(
      screen.queryByTestId("hosted-oauth-loading")
    ).not.toBeInTheDocument();
    expect(screen.getByText("Servers Tab")).toBeInTheDocument();

    await waitFor(() => {
      expect(mockCompleteHostedOAuthCallback).not.toHaveBeenCalled();
    });
  });

  it("escapes a stale queryless callback page back to the root shell", async () => {
    clearHostedOAuthPendingState();
    clearChatboxSession();
    localStorage.removeItem("mcp-oauth-pending");
    localStorage.removeItem("mcp-serverUrl-asana");
    window.history.replaceState({}, "", "/callback");
    writeChatboxSignInReturnPath("/chatbox/asana/token-123");
    mockConvexAuthState.isAuthenticated = false;
    mockConvexAuthState.isLoading = false;
    mockWorkOsAuthState.user = null;
    mockWorkOsAuthState.isLoading = false;

    render(<App />);

    await waitFor(() => {
      expect(window.location.pathname).toBe("/");
    });

    expect(
      screen.queryByTestId("callback-auth-timeout")
    ).not.toBeInTheDocument();
    expect(mockWorkOsAuthState.signIn).not.toHaveBeenCalled();
    expect(readChatboxSignInReturnPath()).toBe("/chatbox/asana/token-123");
  });

  it("clears stale client auth state before retrying a timed-out callback", async () => {
    vi.useFakeTimers();

    try {
      clearHostedOAuthPendingState();
      clearChatboxSession();
      localStorage.removeItem("mcp-oauth-pending");
      localStorage.removeItem("mcp-serverUrl-asana");
      window.history.replaceState({}, "", "/callback?code=oauth-code");
      mockConvexAuthState.isAuthenticated = false;
      mockConvexAuthState.isLoading = false;
      mockWorkOsAuthState.user = null;
      mockWorkOsAuthState.isLoading = false;

      localStorage.setItem("mcp-oauth-pending", "asana");
      localStorage.setItem("mcp-oauth-return-hash", "#asaan");
      localStorage.setItem("workos.test", "stale-local");
      sessionStorage.setItem("workos.session", "stale-session");
      localStorage.setItem(
        "mcpjam_guest_session_v1",
        JSON.stringify({
          guestId: "guest_123",
          token: "guest-token",
          expiresAt: Date.now() + 60_000,
        })
      );
      writeHostedOAuthPendingMarker({
        surface: "project",
        projectId: "ws_1",
        serverId: "srv_asana",
        serverName: "asana",
        serverUrl: "https://mcp.asana.com/sse",
        accessScope: "project_member",
        returnPath: "#servers",
      });
      writeHostedOAuthResumeMarker({
        surface: "project",
        serverName: "asana",
        serverUrl: "https://mcp.asana.com/sse",
        errorMessage: "stale",
      });

      render(<App />);

      await act(async () => {
        await vi.advanceTimersByTimeAsync(15_000);
      });

      expect(screen.getByTestId("callback-auth-timeout")).toBeInTheDocument();

      fireEvent.click(
        screen.getByRole("button", { name: "Try sign in again" })
      );

      await act(async () => {
        await Promise.resolve();
      });

      expect(mockWorkOsAuthState.signIn).toHaveBeenCalledTimes(1);

      expect(window.location.pathname).toBe("/");
      expect(localStorage.getItem("mcp-oauth-pending")).toBeNull();
      expect(localStorage.getItem("mcp-oauth-return-hash")).toBeNull();
      expect(localStorage.getItem("mcp-hosted-oauth-pending")).toBeNull();
      expect(localStorage.getItem("mcp-hosted-oauth-resume")).toBeNull();
      expect(localStorage.getItem("mcpjam_guest_session_v1")).toBeNull();
      expect(localStorage.getItem("workos.test")).toBeNull();
      expect(sessionStorage.getItem("workos.session")).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });

  it("skips billing queries while a persisted org id is still being validated", () => {
    mockUseAppState.mockImplementation(() => ({
      ...createAppStateMock(),
      activeOrganizationId: "stale-org",
    }));

    render(<App />);

    const entitlementsCall = mockUseQuery.mock.calls.find(
      ([name]) => name === "billing:getOrganizationEntitlements"
    );
    const orgPremiumnessCall = mockUseQuery.mock.calls.find(
      ([name]) => name === "billing:getOrganizationPremiumness"
    );
    const wsPremiumnessCall = mockUseQuery.mock.calls.find(
      ([name]) => name === "billing:getProjectPremiumness"
    );

    expect(entitlementsCall?.[1]).toBe("skip");
    expect(orgPremiumnessCall?.[1]).toBe("skip");
    expect(wsPremiumnessCall?.[1]).toBe("skip");
  });

  it("skips billing queries while a project org id is still unvalidated", () => {
    mockUseAppState.mockImplementation(() => ({
      ...createAppStateMock(),
      projects: {
        ws_local: {
          id: "ws_local",
          name: "Shared project",
          organizationId: "project-org",
          servers: {},
          createdAt: new Date(),
          updatedAt: new Date(),
        },
      },
    }));

    render(<App />);

    const entitlementsCall = mockUseQuery.mock.calls.find(
      ([name]) => name === "billing:getOrganizationEntitlements"
    );
    const orgPremiumnessCall = mockUseQuery.mock.calls.find(
      ([name]) => name === "billing:getOrganizationPremiumness"
    );
    const wsPremiumnessCall = mockUseQuery.mock.calls.find(
      ([name]) => name === "billing:getProjectPremiumness"
    );

    expect(entitlementsCall?.[1]).toBe("skip");
    expect(orgPremiumnessCall?.[1]).toBe("skip");
    expect(wsPremiumnessCall?.[1]).toBe("skip");
  });

  it("skips project billing and clears stale synced selection when the active project is missing", async () => {
    const clearConvexActiveProjectSelection = vi.fn();
    mockUseAppState.mockImplementation(() => ({
      ...createAppStateMock(),
      isCloudSyncActive: true,
      activeOrganizationId: "org-1",
      activeProjectId: "ws-missing",
      clearConvexActiveProjectSelection,
    }));
    mockUseQuery.mockImplementation((name: string) => {
      if (name === "users:getCurrentUser") {
        return existingConvexUser;
      }

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

    const wsPremiumnessCall = mockUseQuery.mock.calls.find(
      ([name]) => name === "billing:getProjectPremiumness"
    );

    expect(wsPremiumnessCall?.[1]).toBe("skip");
    await waitFor(() => {
      expect(clearConvexActiveProjectSelection).toHaveBeenCalled();
    });
  });

  it("skips project billing and clears synced selection when the active project org no longer matches the current org", async () => {
    const clearConvexActiveProjectSelection = vi.fn();
    mockUseAppState.mockImplementation(() => ({
      ...createAppStateMock(),
      isCloudSyncActive: true,
      activeOrganizationId: "org-1",
      clearConvexActiveProjectSelection,
      projects: {
        ws_local: {
          id: "ws_local",
          name: "Project Two",
          sharedProjectId: "shared-ws-2",
          organizationId: "org-2",
          servers: {},
          createdAt: new Date(),
          updatedAt: new Date(),
        },
      },
    }));
    mockUseQuery.mockImplementation((name: string) => {
      if (name === "users:getCurrentUser") {
        return existingConvexUser;
      }

      if (name === "organizations:getMyOrganizations") {
        return [
          {
            _id: "org-1",
            name: "Org One",
            updatedAt: 2,
            createdAt: 1,
            createdBy: "user-1",
            myRole: "owner",
          },
          {
            _id: "org-2",
            name: "Org Two",
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

    const wsPremiumnessCall = mockUseQuery.mock.calls.find(
      ([name]) => name === "billing:getProjectPremiumness"
    );

    expect(wsPremiumnessCall?.[1]).toBe("skip");
    await waitFor(() => {
      expect(clearConvexActiveProjectSelection).toHaveBeenCalled();
    });
  });

  // (Removed) "passes a billing-safe project id to the chatboxes tab" —
  // the old test asserted that ChatboxesTab received
  // `{ projectId: null, organizationId, isBillingContextPending }` when
  // cloud sync was off, gating the org-scoped billing gate. After the
  // 1:1 host↔chatbox consolidation the tab signature is just
  // `{ projectId, isAuthenticated }` (no org / billing props), and the
  // ChatboxesRoute forwards the route-context `convexProjectId` whether
  // cloud sync is on or off. The previous invariant no longer maps to a
  // prop on this component, so the test was deleted rather than
  // rewritten against a different surface.

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
      expect(mockCompleteHostedOAuthCallback).toHaveBeenCalledWith(
        expect.objectContaining({
          surface: "chatbox",
          serverName: "asana",
        }),
        "oauth-code",
        expect.objectContaining({
          onTraceUpdate: expect.any(Function),
        })
      );
    });

    expect(setActiveOrganizationId).not.toHaveBeenCalled();
  });

  it("passes the valid organization route into app state for project actions", async () => {
    clearHostedOAuthPendingState();
    clearChatboxSession();
    window.history.replaceState({}, "", "/organizations/org-3");
    mockUseAppState.mockImplementation(() => ({
      ...createAppStateMock(),
      activeOrganizationId: "org-1",
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
          {
            _id: "org-3",
            name: "Org Three",
            updatedAt: 2,
            createdAt: 2,
            createdBy: "user-1",
            myRole: "owner",
          },
        ];
      }

      return undefined;
    });

    render(<App />);

    await waitFor(() => {
      expect(mockUseAppState).toHaveBeenCalled();
    });

    const lastCall =
      mockUseAppState.mock.calls[mockUseAppState.mock.calls.length - 1];
    expect(lastCall?.[0]).toMatchObject({
      routeOrganizationId: "org-3",
    });
  });

  it("keeps the sidebar-selected org active when navigating back to servers", async () => {
    clearHostedOAuthPendingState();
    clearChatboxSession();
    window.history.replaceState({}, "", "/organizations/org-a");

    const setActiveOrganizationIdSpy = vi.fn();
    mockUseAppState.mockImplementation(() => {
      const [activeOrganizationId, setActiveOrganizationId] = useState<
        string | undefined
      >("org-a");

      return {
        ...createAppStateMock(),
        activeOrganizationId,
        setActiveOrganizationId: (organizationId: string | undefined) => {
          setActiveOrganizationIdSpy(organizationId);
          setActiveOrganizationId(organizationId);
        },
      };
    });
    mockUseQuery.mockImplementation((name: string) => {
      if (name === "organizations:getMyOrganizations") {
        return [
          {
            _id: "org-a",
            name: "Org A",
            updatedAt: 1,
            createdAt: 1,
            createdBy: "user-1",
            myRole: "owner",
          },
          {
            _id: "org-b",
            name: "Org B",
            updatedAt: 2,
            createdAt: 2,
            createdBy: "user-1",
            myRole: "owner",
          },
        ];
      }

      return undefined;
    });

    render(<App />);

    await waitFor(() => {
      expect(mockMCPSidebar).toHaveBeenCalled();
    });

    const getLastSidebarProps = () =>
      mockMCPSidebar.mock.calls[mockMCPSidebar.mock.calls.length - 1]?.[0] as {
        activeOrganizationId?: string;
        onNavigate?: (section: string) => void;
        onSwitchOrganization?: (organizationId: string) => void;
      };

    act(() => {
      getLastSidebarProps().onSwitchOrganization?.("org-b");
    });

    await waitFor(() => {
      expect(setActiveOrganizationIdSpy).toHaveBeenCalledWith("org-b");
      expect(getLastSidebarProps().activeOrganizationId).toBe("org-b");
      expect(window.location.pathname).toBe("/organizations/org-b");
    });

    act(() => {
      getLastSidebarProps().onNavigate?.("servers");
    });

    await waitFor(() => {
      expect(getLastSidebarProps().activeOrganizationId).toBe("org-b");
      expect(window.location.pathname).toBe("/servers");
    });
  });

  it("preserves the newly selected org when navigating away immediately", async () => {
    clearHostedOAuthPendingState();
    clearChatboxSession();
    window.history.replaceState({}, "", "/organizations/org-a");

    const setActiveOrganizationIdSpy = vi.fn();
    mockUseAppState.mockImplementation(() => {
      const [activeOrganizationId, setActiveOrganizationId] = useState<
        string | undefined
      >("org-a");

      return {
        ...createAppStateMock(),
        activeOrganizationId,
        setActiveOrganizationId: (organizationId: string | undefined) => {
          setActiveOrganizationIdSpy(organizationId);
          setActiveOrganizationId(organizationId);
        },
      };
    });
    mockUseQuery.mockImplementation((name: string) => {
      if (name === "organizations:getMyOrganizations") {
        return [
          {
            _id: "org-a",
            name: "Org A",
            updatedAt: 1,
            createdAt: 1,
            createdBy: "user-1",
            myRole: "owner",
          },
          {
            _id: "org-b",
            name: "Org B",
            updatedAt: 2,
            createdAt: 2,
            createdBy: "user-1",
            myRole: "owner",
          },
        ];
      }

      return undefined;
    });

    render(<App />);

    await waitFor(() => {
      expect(mockMCPSidebar).toHaveBeenCalled();
    });

    const getLastSidebarProps = () =>
      mockMCPSidebar.mock.calls[mockMCPSidebar.mock.calls.length - 1]?.[0] as {
        activeOrganizationId?: string;
        onNavigate?: (section: string) => void;
        onSwitchOrganization?: (organizationId: string) => void;
      };

    act(() => {
      getLastSidebarProps().onSwitchOrganization?.("org-b");
      getLastSidebarProps().onNavigate?.("servers");
    });

    await waitFor(() => {
      expect(setActiveOrganizationIdSpy).toHaveBeenCalledWith("org-b");
      expect(getLastSidebarProps().activeOrganizationId).toBe("org-b");
      expect(window.location.pathname).toBe("/servers");
    });
  });

  it("does not snap initial project hydration back to servers", async () => {
    clearHostedOAuthPendingState();
    clearChatboxSession();
    window.history.replaceState({}, "", "/#settings");

    mockUseAppState.mockImplementation(() => {
      const [hydrated, setHydrated] = useState(false);

      useLayoutEffect(() => {
        setHydrated(true);
      }, []);

      return {
        ...createAppStateMock(),
        isLoadingRemoteProjects: !hydrated,
        activeProjectId: hydrated ? "convex-project" : "local-default",
        projects: hydrated
          ? {
              "convex-project": {
                id: "convex-project",
                name: "Convex Project",
                servers: {},
              },
            }
          : {},
      };
    });

    render(<App />);

    await waitFor(() => {
      expect(mockUseAppState.mock.calls.length).toBeGreaterThan(1);
    });

    expect(window.location.hash).toBe("#settings");
  });

  it("preserves the org models section when switching active organization", async () => {
    clearHostedOAuthPendingState();
    clearChatboxSession();
    window.history.replaceState({}, "", "/organizations/org-a/models");

    const setActiveOrganizationIdSpy = vi.fn();
    (mockUseAppState as any).mockImplementation(() => {
      const [activeOrganizationId, setActiveOrganizationId] = useState<
        string | undefined
      >("org-a");

      return {
        ...createAppStateMock(),
        activeOrganizationId,
        setActiveOrganizationId: (organizationId: string | undefined) => {
          setActiveOrganizationIdSpy(organizationId);
          setActiveOrganizationId(organizationId);
        },
      };
    });
    (mockUseQuery as any).mockImplementation((name: string) => {
      if (name === "organizations:getMyOrganizations") {
        return [
          {
            _id: "org-a",
            name: "Org A",
            updatedAt: 1,
            createdAt: 1,
            createdBy: "user-1",
            myRole: "owner",
          },
          {
            _id: "org-b",
            name: "Org B",
            updatedAt: 2,
            createdAt: 2,
            createdBy: "user-1",
            myRole: "owner",
          },
        ];
      }

      return undefined;
    });

    render(<App />);

    await waitFor(() => {
      expect(mockMCPSidebar).toHaveBeenCalled();
    });

    const getLastSidebarProps = () => {
      const lastCall =
        mockMCPSidebar.mock.calls[mockMCPSidebar.mock.calls.length - 1];
      return lastCall?.[0] as unknown as {
        activeOrganizationId?: string;
        onSwitchActiveOrganization?: (organizationId: string) => void;
      };
    };

    act(() => {
      getLastSidebarProps().onSwitchActiveOrganization?.("org-b");
    });

    await waitFor(() => {
      expect(setActiveOrganizationIdSpy).toHaveBeenCalledWith("org-b");
      expect(getLastSidebarProps().activeOrganizationId).toBe("org-b");
      expect(window.location.pathname).toBe("/organizations/org-b/models");
    });
  });

  it("disables sidebar project creation when the routed org is free and at cap", async () => {
    clearHostedOAuthPendingState();
    clearChatboxSession();
    window.history.replaceState({}, "", "/organizations/org-3");
    mockUseFeatureFlagEnabled.mockImplementation(
      (flag: string) => flag === "billing-entitlements-ui"
    );
    mockUseAppState.mockImplementation(() => ({
      ...createAppStateMock(),
      activeOrganizationId: "org-1",
    }));
    mockUseQuery.mockImplementation((name: string, args?: any) => {
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
          {
            _id: "org-3",
            name: "Org Three",
            updatedAt: 2,
            createdAt: 2,
            createdBy: "user-1",
            myRole: "owner",
          },
        ];
      }
      if (
        name === "billing:getOrganizationBillingStatus" &&
        args?.organizationId === "org-3"
      ) {
        return {
          organizationId: "org-3",
          organizationName: "Org Three",
          plan: "free",
          effectivePlan: "free",
          source: "free",
          billingInterval: null,
          billingConfigured: true,
          subscriptionStatus: null,
          canManageBilling: true,
          isOwner: true,
          hasCustomer: false,
          stripeCurrentPeriodEnd: null,
          stripePriceId: null,
          trialStatus: "none",
          trialPlan: null,
          trialStartedAt: null,
          trialEndsAt: null,
          trialDaysRemaining: null,
          decisionRequired: false,
          trialDecision: null,
        };
      }
      if (
        name === "billing:getOrganizationPremiumness" &&
        args?.organizationId === "org-3"
      ) {
        return {
          plan: "free",
          effectivePlan: "free",
          billingInterval: null,
          source: "free",
          enforcementState: "active",
          decisionRequired: false,
          gates: [
            {
              gateKey: "maxProjects",
              kind: "limit",
              scope: "organization",
              canAccess: false,
              shouldShowUpsell: true,
              upgradePlan: "team",
              reason: "limit_reached",
              currentValue: 1,
              allowedValue: 1,
            },
          ],
        };
      }

      return undefined;
    });

    render(<App />);

    await waitFor(() => {
      expect(mockMCPSidebar).toHaveBeenCalled();
    });

    const lastCall =
      mockMCPSidebar.mock.calls[mockMCPSidebar.mock.calls.length - 1];
    expect(lastCall?.[0]).toMatchObject({
      isCreateProjectDisabled: true,
      createProjectDisabledReason:
        "This organization has reached its project limit (1). Upgrade to create more projects.",
    });
  });

  it("shows billing handoff loading and triggers sign-in for guest billing entry", async () => {
    clearHostedOAuthPendingState();
    clearChatboxSession();
    window.history.replaceState({}, "", "/billing?plan=team&interval=annual");

    const signIn = vi.fn();
    mockUseAuth.mockReturnValue({
      getAccessToken: vi.fn(),
      signIn,
      user: null,
      isLoading: false,
    });
    mockUseConvexAuth.mockReturnValue({
      isAuthenticated: false,
      isLoading: false,
    });

    render(<App />);

    expect(screen.getByTestId("billing-handoff-loading")).toBeInTheDocument();
    await waitFor(() => {
      expect(signIn).toHaveBeenCalled();
    });
    expect(readPersistedCheckoutIntent()).toEqual({
      plan: "team",
      interval: "annual",
    });
    expect(readBillingSignInReturnPath()).toBe("/billing");
    expect(mockOrganizationsTab).not.toHaveBeenCalled();
  });

  it("restores the billing callback back into the billing flow when session intent exists", async () => {
    clearHostedOAuthPendingState();
    clearChatboxSession();
    sessionStorage.clear();
    persistCheckoutIntent({ plan: "team", interval: "annual" });
    writeBillingSignInReturnPath("/billing");
    window.history.replaceState({}, "", "/callback?code=oauth-code");

    mockUseFeatureFlagEnabled.mockImplementation(
      (flag: string) => flag === "billing-entitlements-ui"
    );
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

    const replaceStateSpy = vi.spyOn(window.history, "replaceState");

    render(<App />);

    await waitFor(() => {
      expect(replaceStateSpy).toHaveBeenCalledWith({}, "", "/billing");
      expect(screen.getByTestId("billing-handoff-overlay")).toBeInTheDocument();
    });
    expect(readBillingSignInReturnPath()).toBeNull();
  });

  it("falls back to the default callback destination when billing session intent is missing", async () => {
    clearHostedOAuthPendingState();
    clearChatboxSession();
    sessionStorage.clear();
    writeBillingSignInReturnPath("/billing");
    window.history.replaceState({}, "", "/callback?code=oauth-code");

    const replaceStateSpy = vi.spyOn(window.history, "replaceState");

    render(<App />);

    await waitFor(() => {
      expect(replaceStateSpy).toHaveBeenCalledWith({}, "", "/");
      expect(screen.getByText("Servers Tab")).toBeInTheDocument();
    });
    expect(readBillingSignInReturnPath()).toBeNull();
  });

  it("keeps a persisted billing resume alive when /billing returns without query params", async () => {
    clearHostedOAuthPendingState();
    clearChatboxSession();
    sessionStorage.clear();
    persistCheckoutIntent({ plan: "team", interval: "annual" });
    window.history.replaceState({}, "", "/billing");

    mockUseFeatureFlagEnabled.mockImplementation(
      (flag: string) => flag === "billing-entitlements-ui"
    );
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
      expect(screen.getByTestId("billing-handoff-overlay")).toBeInTheDocument();
      expect(mockOrganizationsTab).toHaveBeenCalled();
    });

    expect(
      mockOrganizationsTab.mock.calls.some(
        ([props]) =>
          props &&
          typeof props === "object" &&
          "organizationId" in props &&
          "section" in props &&
          "checkoutIntent" in props &&
          (
            props as {
              organizationId?: string;
              section?: string;
              checkoutIntent?: { plan?: string; interval?: string };
            }
          ).organizationId === "org-1" &&
          (props as { section?: string }).section === "billing" &&
          (props as { checkoutIntent?: { plan?: string } }).checkoutIntent
            ?.plan === "team" &&
          (props as { checkoutIntent?: { interval?: string } }).checkoutIntent
            ?.interval === "annual"
      )
    ).toBe(true);
  });

  it("prefers chatbox callback restoration over billing callback restoration", async () => {
    clearHostedOAuthPendingState();
    clearChatboxSession();
    sessionStorage.clear();
    persistCheckoutIntent({ plan: "team", interval: "annual" });
    writeBillingSignInReturnPath("/billing");
    writeChatboxSignInReturnPath("/chatbox/demo/token-123");
    window.history.replaceState({}, "", "/callback?code=oauth-code");

    const replaceStateSpy = vi.spyOn(window.history, "replaceState");

    render(<App />);

    await waitFor(() => {
      expect(replaceStateSpy).toHaveBeenCalledWith(
        {},
        "",
        "/chatbox/demo/token-123"
      );
    });
  });

  it("keeps billing resume behind the checkout spinner for signed-in users", async () => {
    clearHostedOAuthPendingState();
    clearChatboxSession();
    window.history.replaceState({}, "", "/billing?plan=team&interval=annual");

    mockUseFeatureFlagEnabled.mockImplementation(
      (flag: string) => flag === "billing-entitlements-ui"
    );
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

    expect(screen.getByText("Preparing checkout...")).toBeInTheDocument();

    await waitFor(() => {
      expect(screen.getByTestId("billing-handoff-overlay")).toBeInTheDocument();
      expect(mockOrganizationsTab).toHaveBeenCalled();
    });

    expect(
      mockOrganizationsTab.mock.calls.some(
        ([props]) =>
          props &&
          typeof props === "object" &&
          "organizationId" in props &&
          "section" in props &&
          "checkoutIntent" in props &&
          (
            props as {
              organizationId?: string;
              section?: string;
              checkoutIntent?: { plan?: string; interval?: string };
            }
          ).organizationId === "org-1" &&
          (props as { section?: string }).section === "billing" &&
          (props as { checkoutIntent?: { plan?: string } }).checkoutIntent
            ?.plan === "team" &&
          (props as { checkoutIntent?: { interval?: string } }).checkoutIntent
            ?.interval === "annual"
      )
    ).toBe(true);
  });

  it("drops the billing overlay when checkout intent is consumed", async () => {
    clearHostedOAuthPendingState();
    clearChatboxSession();
    window.history.replaceState({}, "", "/billing?plan=team&interval=annual");

    mockUseFeatureFlagEnabled.mockImplementation(
      (flag: string) => flag === "billing-entitlements-ui"
    );
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
    mockOrganizationsTab.mockImplementation(
      (props: { onCheckoutIntentConsumed?: () => void }) => (
        <button
          type="button"
          data-testid="consume-checkout-intent"
          onClick={() => props.onCheckoutIntentConsumed?.()}
        >
          Consume checkout intent
        </button>
      )
    );

    render(<App />);

    await waitFor(() => {
      expect(screen.getByTestId("billing-handoff-overlay")).toBeInTheDocument();
      expect(screen.getByTestId("consume-checkout-intent")).toBeInTheDocument();
    });

    fireEvent.click(screen.getByTestId("consume-checkout-intent"));

    await waitFor(() => {
      expect(
        screen.queryByTestId("billing-handoff-overlay")
      ).not.toBeInTheDocument();
    });
  });

  it("drops the billing overlay when checkout navigation starts", async () => {
    clearHostedOAuthPendingState();
    clearChatboxSession();
    window.history.replaceState({}, "", "/billing?plan=team&interval=annual");

    mockUseFeatureFlagEnabled.mockImplementation(
      (flag: string) => flag === "billing-entitlements-ui"
    );
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
    mockOrganizationsTab.mockImplementation(
      (props: { onCheckoutIntentNavigationStarted?: () => void }) => (
        <button
          type="button"
          data-testid="start-checkout-navigation"
          onClick={() => props.onCheckoutIntentNavigationStarted?.()}
        >
          Start checkout navigation
        </button>
      )
    );

    render(<App />);

    await waitFor(() => {
      expect(screen.getByTestId("billing-handoff-overlay")).toBeInTheDocument();
      expect(
        screen.getByTestId("start-checkout-navigation")
      ).toBeInTheDocument();
    });

    fireEvent.click(screen.getByTestId("start-checkout-navigation"));

    await waitFor(() => {
      expect(
        screen.queryByTestId("billing-handoff-overlay")
      ).not.toBeInTheDocument();
    });
    expect(readPersistedCheckoutIntent()).toBeNull();
  });

  it("clears billing handoff state when no organization is available", async () => {
    clearHostedOAuthPendingState();
    clearChatboxSession();
    window.history.replaceState({}, "", "/billing?plan=team&interval=annual");

    mockUseFeatureFlagEnabled.mockImplementation(
      (flag: string) => flag === "billing-entitlements-ui"
    );
    mockUseQuery.mockImplementation((name: string) => {
      if (name === "organizations:getMyOrganizations") {
        return [];
      }

      return undefined;
    });

    render(<App />);

    await waitFor(() => {
      expect(screen.getByText("Servers Tab")).toBeInTheDocument();
    });

    expect(
      screen.queryByTestId("billing-handoff-loading")
    ).not.toBeInTheDocument();
    expect(
      screen.queryByTestId("billing-handoff-overlay")
    ).not.toBeInTheDocument();
    expect(mockOrganizationsTab).not.toHaveBeenCalled();
  });

  it("renders the organization route from the hash even before active org state catches up", async () => {
    clearHostedOAuthPendingState();
    clearChatboxSession();
    window.history.replaceState({}, "", "/organizations/org-1");
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

  it("optimistically switches to the first owned org after deleting the current org", async () => {
    clearHostedOAuthPendingState();
    clearChatboxSession();
    window.history.replaceState({}, "", "/organizations/org-deleted");

    const setActiveOrganizationId = vi.fn();
    const clearConvexActiveProjectSelection = vi.fn();
    const clearLocalFallbackProjectSelection = vi.fn();
    mockUseAppState.mockImplementation(() => ({
      ...createAppStateMock(),
      activeOrganizationId: "org-deleted",
      setActiveOrganizationId,
      clearConvexActiveProjectSelection,
      clearLocalFallbackProjectSelection,
      projects: {
        ws_local: {
          id: "ws_local",
          name: "Deleted Project",
          sharedProjectId: "shared-ws-deleted",
          organizationId: "org-deleted",
          servers: {},
          createdAt: new Date(),
          updatedAt: new Date(),
        },
      },
    }));
    mockUseQuery.mockImplementation((name: string) => {
      if (name === "users:getCurrentUser") {
        return existingConvexUser;
      }

      if (name === "organizations:getMyOrganizations") {
        return [
          {
            _id: "org-deleted",
            name: "Deleted Org",
            updatedAt: 3,
            createdAt: 1,
            createdBy: "user-1",
            myRole: "owner",
          },
          {
            _id: "org-owned",
            name: "Owned Org",
            updatedAt: 2,
            createdAt: 1,
            createdBy: "user-1",
            myRole: "owner",
          },
          {
            _id: "org-member",
            name: "Member Org",
            updatedAt: 1,
            createdAt: 1,
            createdBy: "user-2",
            myRole: "member",
          },
        ];
      }

      return undefined;
    });
    mockOrganizationsTab.mockImplementation(
      (props: { onOrganizationDeleted?: (organizationId: string) => void }) => (
        <button
          type="button"
          data-testid="delete-org"
          onClick={() => props.onOrganizationDeleted?.("org-deleted")}
        >
          Delete org
        </button>
      )
    );

    render(<App />);

    fireEvent.click(await screen.findByTestId("delete-org"));

    await waitFor(() => {
      expect(setActiveOrganizationId).toHaveBeenLastCalledWith("org-owned");
    });

    expect(clearConvexActiveProjectSelection).toHaveBeenCalled();
    expect(clearLocalFallbackProjectSelection).toHaveBeenCalledWith(
      "org-deleted",
      "org-owned"
    );
    expect(window.location.pathname).toBe("/servers");
  });

  it("falls back to the first remaining org when no owned org remains after delete", async () => {
    clearHostedOAuthPendingState();
    clearChatboxSession();
    window.history.replaceState({}, "", "/organizations/org-deleted");

    const setActiveOrganizationId = vi.fn();
    mockUseAppState.mockImplementation(() => ({
      ...createAppStateMock(),
      activeOrganizationId: "org-deleted",
      setActiveOrganizationId,
    }));
    mockUseQuery.mockImplementation((name: string) => {
      if (name === "users:getCurrentUser") {
        return existingConvexUser;
      }

      if (name === "organizations:getMyOrganizations") {
        return [
          {
            _id: "org-deleted",
            name: "Deleted Org",
            updatedAt: 4,
            createdAt: 1,
            createdBy: "user-1",
            myRole: "member",
          },
          {
            _id: "org-first",
            name: "First Remaining Org",
            updatedAt: 3,
            createdAt: 1,
            createdBy: "user-2",
            myRole: "member",
          },
          {
            _id: "org-second",
            name: "Second Remaining Org",
            updatedAt: 2,
            createdAt: 1,
            createdBy: "user-3",
            myRole: "guest",
          },
        ];
      }

      return undefined;
    });
    mockOrganizationsTab.mockImplementation(
      (props: { onOrganizationDeleted?: (organizationId: string) => void }) => (
        <button
          type="button"
          data-testid="delete-org-no-owner"
          onClick={() => props.onOrganizationDeleted?.("org-deleted")}
        >
          Delete org with no owner fallback
        </button>
      )
    );

    render(<App />);

    fireEvent.click(await screen.findByTestId("delete-org-no-owner"));

    await waitFor(() => {
      expect(setActiveOrganizationId).toHaveBeenLastCalledWith("org-first");
    });

    expect(window.location.pathname).toBe("/servers");
  });

  it("clears deleted-org fallback state without switching away from a different active org", async () => {
    clearHostedOAuthPendingState();
    clearChatboxSession();
    window.history.replaceState({}, "", "/organizations/org-member");

    const setActiveOrganizationId = vi.fn();
    const clearConvexActiveProjectSelection = vi.fn();
    const clearLocalFallbackProjectSelection = vi.fn();
    mockUseAppState.mockImplementation(() => ({
      ...createAppStateMock(),
      activeOrganizationId: "org-member",
      setActiveOrganizationId,
      clearConvexActiveProjectSelection,
      clearLocalFallbackProjectSelection,
      projects: {
        ws_local: {
          id: "ws_local",
          name: "Active Project",
          sharedProjectId: "shared-ws-active",
          organizationId: "org-member",
          servers: {},
          createdAt: new Date(),
          updatedAt: new Date(),
        },
      },
    }));
    mockUseQuery.mockImplementation((name: string) => {
      if (name === "users:getCurrentUser") {
        return existingConvexUser;
      }

      if (name === "organizations:getMyOrganizations") {
        return [
          {
            _id: "org-owner",
            name: "Owner Org",
            updatedAt: 3,
            createdAt: 1,
            createdBy: "user-1",
            myRole: "owner",
          },
          {
            _id: "org-deleted",
            name: "Deleted Org",
            updatedAt: 2,
            createdAt: 1,
            createdBy: "user-1",
            myRole: "owner",
          },
          {
            _id: "org-member",
            name: "Member Org",
            updatedAt: 1,
            createdAt: 1,
            createdBy: "user-2",
            myRole: "member",
          },
        ];
      }

      return undefined;
    });
    mockOrganizationsTab.mockImplementation(
      (props: { onOrganizationDeleted?: (organizationId: string) => void }) => (
        <button
          type="button"
          data-testid="delete-non-current-org"
          onClick={() => props.onOrganizationDeleted?.("org-deleted")}
        >
          Delete non-current org
        </button>
      )
    );

    render(<App />);

    const activeOrgCallsBeforeDelete =
      setActiveOrganizationId.mock.calls.length;
    fireEvent.click(await screen.findByTestId("delete-non-current-org"));

    await waitFor(() => {
      expect(clearLocalFallbackProjectSelection).toHaveBeenCalledWith(
        "org-deleted",
        "org-owner"
      );
    });

    const postDeleteCalls = setActiveOrganizationId.mock.calls.slice(
      activeOrgCallsBeforeDelete
    );
    expect(postDeleteCalls).not.toContainEqual(["org-owner"]);
    expect(clearConvexActiveProjectSelection).not.toHaveBeenCalled();
    expect(window.location.pathname).toBe("/organizations/org-member");
  });

  it("clears org and synced project selection when deleting the last org", async () => {
    clearHostedOAuthPendingState();
    clearChatboxSession();
    window.history.replaceState({}, "", "/organizations/org-deleted");

    const setActiveOrganizationId = vi.fn();
    const clearConvexActiveProjectSelection = vi.fn();
    const clearLocalFallbackProjectSelection = vi.fn();
    mockUseAppState.mockImplementation(() => ({
      ...createAppStateMock(),
      activeOrganizationId: "org-deleted",
      setActiveOrganizationId,
      clearConvexActiveProjectSelection,
      clearLocalFallbackProjectSelection,
      projects: {
        ws_local: {
          id: "ws_local",
          name: "Deleted Project",
          sharedProjectId: "shared-ws-deleted",
          organizationId: "org-deleted",
          servers: {},
          createdAt: new Date(),
          updatedAt: new Date(),
        },
      },
    }));
    mockUseQuery.mockImplementation((name: string) => {
      if (name === "users:getCurrentUser") {
        return existingConvexUser;
      }

      if (name === "organizations:getMyOrganizations") {
        return [
          {
            _id: "org-deleted",
            name: "Deleted Org",
            updatedAt: 1,
            createdAt: 1,
            createdBy: "user-1",
            myRole: "owner",
          },
        ];
      }

      return undefined;
    });
    mockOrganizationsTab.mockImplementation(
      (props: { onOrganizationDeleted?: (organizationId: string) => void }) => (
        <button
          type="button"
          data-testid="delete-last-org"
          onClick={() => props.onOrganizationDeleted?.("org-deleted")}
        >
          Delete last org
        </button>
      )
    );

    render(<App />);

    fireEvent.click(await screen.findByTestId("delete-last-org"));

    await waitFor(() => {
      expect(setActiveOrganizationId).toHaveBeenLastCalledWith(undefined);
    });

    expect(clearConvexActiveProjectSelection).toHaveBeenCalled();
    expect(clearLocalFallbackProjectSelection).toHaveBeenCalledWith(
      "org-deleted",
      undefined
    );
    expect(window.location.pathname).toBe("/servers");
  });

  // (Removed) "still renders the chatboxes tab when project premiumness
  // denies chatbox creation" — chatbox creation no longer happens on the
  // /chatboxes tab (it's the publish surface for a host-bound chatbox
  // that's created with the host). The test's premise — that the tab
  // has its own billing gate for creation — no longer exists, so the
  // test was deleted rather than rewritten.

  it("navigates back to the chatboxes tab after callback completion", async () => {
    clearHostedOAuthPendingState();
    clearChatboxSession();
    writeHostedOAuthPendingMarker({
      surface: "chatbox",
      projectId: "ws_1",
      serverId: "srv_asana",
      sessionId: "hosted-session-chatboxes",
      accessScope: "chat_v2",
      chatboxId: "sbx_1",
      accessVersion: 1,
      serverName: "asana",
      serverUrl: "https://mcp.asana.com/sse",
      returnPath: "#chatboxes",
    });
    mockCompleteHostedOAuthCallback.mockResolvedValue({
      success: true,
      serverName: "asana",
      serverConfig: {
        url: "https://mcp.asana.com/sse",
        requestInit: { headers: { Authorization: "Bearer token" } },
      },
    });

    render(<App />);

    await waitFor(() => {
      expect(window.location.pathname).toBe("/chatboxes");
      expect(screen.getByText("Chatboxes Tab")).toBeInTheDocument();
    });
    expect(screen.queryByText("Servers Tab")).not.toBeInTheDocument();
  });

  it("keeps App Builder mounted when onboarding chrome is restored", async () => {
    clearHostedOAuthPendingState();
    clearChatboxSession();
    window.history.replaceState({}, "", "/app-builder");
    mockHandleOAuthCallback.mockReset();
    mockUseFeatureFlagEnabled.mockImplementation(
      (flag: string) => flag === "playground-enabled"
    );

    render(<App />);

    await waitFor(() => {
      expect(screen.getByTestId("app-builder-tab")).toBeInTheDocument();
    });

    expect(screen.queryByTestId("mcp-sidebar")).not.toBeInTheDocument();
    expect(screen.queryByTestId("app-header")).not.toBeInTheDocument();

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
    clearChatboxSession();
    window.history.replaceState({}, "", "/app-builder");
    mockHandleOAuthCallback.mockReset();
    mockUseFeatureFlagEnabled.mockImplementation(
      (flag: string) => flag === "playground-enabled"
    );

    render(<App />);

    await waitFor(() => {
      expect(screen.getByTestId("app-builder-tab")).toBeInTheDocument();
    });

    expect(screen.queryByTestId("mcp-sidebar")).not.toBeInTheDocument();
    expect(screen.queryByTestId("app-header")).not.toBeInTheDocument();

    window.history.pushState({}, "", "/servers");
    window.dispatchEvent(new Event("popstate"));

    await waitFor(() => {
      expect(screen.getByText("Servers Tab")).toBeInTheDocument();
      expect(screen.getByTestId("mcp-sidebar")).toBeInTheDocument();
      expect(screen.getByTestId("app-header")).toBeInTheDocument();
    });

    expect(screen.queryByTestId("app-builder-tab")).not.toBeInTheDocument();
  });

  it("auto-routes a Convex-authenticated hosted guest into App Builder onboarding once startup is ready", async () => {
    clearHostedOAuthPendingState();
    clearChatboxSession();
    mockUnseenOnboardingState();
    window.history.replaceState({}, "", "/servers");
    mockHandleOAuthCallback.mockReset();
    mockConvexAuthState.isAuthenticated = true;
    mockWorkOsAuthState.user = null;
    mockHostedShellGateState.value = "ready";
    mockFreshGuestUser();

    render(<App />);

    await waitFor(() => {
      expect(screen.getByTestId("app-builder-tab")).toBeInTheDocument();
    });

    expect(window.location.pathname).toBe("/app-builder");
    expect(screen.queryByText("Servers Tab")).not.toBeInTheDocument();
    expect(mockAppBuilderTabProps).toHaveBeenLastCalledWith(
      expect.objectContaining({
        isSignedInWithWorkOs: false,
        isWorkOsAuthLoading: false,
        isConvexAuthenticated: true,
        hasSeenFirstRunOnboarding: false,
      })
    );
  });

  it("does not auto-route a guest row already marked as having seen onboarding", async () => {
    clearHostedOAuthPendingState();
    clearChatboxSession();
    mockUnseenOnboardingState();
    window.history.replaceState({}, "", "/servers");
    mockHandleOAuthCallback.mockReset();
    mockConvexAuthState.isAuthenticated = true;
    mockWorkOsAuthState.user = null;
    mockHostedShellGateState.value = "ready";
    mockSeenGuestUser();

    render(<App />);

    await waitFor(() => {
      expect(screen.getByText("Servers Tab")).toBeInTheDocument();
    });

    expect(window.location.pathname).toBe("/servers");
    expect(screen.queryByTestId("app-builder-tab")).not.toBeInTheDocument();
  });

  it("auto-routes an unseen guest when the only saved server is the incomplete first-run Excalidraw row", async () => {
    clearHostedOAuthPendingState();
    clearChatboxSession();
    mockUnseenOnboardingState();
    window.history.replaceState({}, "", "/servers");
    mockHandleOAuthCallback.mockReset();
    mockConvexAuthState.isAuthenticated = true;
    mockWorkOsAuthState.user = null;
    mockHostedShellGateState.value = "ready";
    mockFreshGuestUser();
    mockUseAppState.mockImplementation(() => ({
      ...createAppStateMock(),
      projectServers: {
        "Excalidraw (App)": {
          name: "Excalidraw (App)",
          connectionStatus: "disconnected",
          enabled: true,
          retryCount: 0,
          lastConnectionTime: new Date("2026-01-01T00:00:00.000Z"),
          config: {
            transportType: "http",
            url: "https://mcp.excalidraw.com/mcp",
          },
        },
      },
    }));

    render(<App />);

    await waitFor(() => {
      expect(screen.getByTestId("app-builder-tab")).toBeInTheDocument();
    });

    expect(window.location.pathname).toBe("/app-builder");
  });

  it("does not auto-route to App Builder when any saved server already exists", async () => {
    clearHostedOAuthPendingState();
    clearChatboxSession();
    mockUnseenOnboardingState();
    window.history.replaceState({}, "", "/servers");
    mockHandleOAuthCallback.mockReset();
    mockFreshGuestUser();
    mockUseAppState.mockImplementation(() => ({
      ...createAppStateMock(),
      projectServers: {
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

    expect(window.location.pathname).toBe("/servers");
    expect(screen.queryByTestId("app-builder-tab")).not.toBeInTheDocument();
  });

  it("does not auto-route to App Builder while the guest project is still provisioning", async () => {
    clearHostedOAuthPendingState();
    clearChatboxSession();
    mockUnseenOnboardingState();
    window.history.replaceState({}, "", "/servers");
    mockHandleOAuthCallback.mockReset();
    mockHostedShellGateState.value = "ready";
    mockFreshGuestUser();
    mockUseAppState.mockImplementation(() => ({
      ...createAppStateMock(),
      activeProjectId: "none",
    }));

    render(<App />);

    await waitFor(() => {
      expect(screen.getByText("Servers Tab")).toBeInTheDocument();
    });

    expect(window.location.pathname).toBe("/servers");
    expect(screen.queryByTestId("app-builder-tab")).not.toBeInTheDocument();
  });

  it("does not auto-route to App Builder before hosted guest Convex auth is ready", async () => {
    clearHostedOAuthPendingState();
    clearChatboxSession();
    mockUnseenOnboardingState();
    window.history.replaceState({}, "", "/servers");
    mockHandleOAuthCallback.mockReset();
    mockHostedShellGateState.value = "ready";
    mockConvexAuthState.isAuthenticated = false;
    mockConvexAuthState.isLoading = false;
    mockWorkOsAuthState.user = null;
    mockFreshGuestUser();

    render(<App />);

    await waitFor(() => {
      expect(screen.getByText("Servers Tab")).toBeInTheDocument();
    });

    expect(window.location.pathname).toBe("/servers");
    expect(screen.queryByTestId("app-builder-tab")).not.toBeInTheDocument();
  });

  it("does not auto-route to App Builder while the hosted shell is still auth-loading", async () => {
    clearHostedOAuthPendingState();
    clearChatboxSession();
    mockUnseenOnboardingState();
    window.history.replaceState({}, "", "/servers");
    mockHandleOAuthCallback.mockReset();
    mockHostedShellGateState.value = "auth-loading";

    render(<App />);

    await waitFor(() => {
      expect(screen.getByTestId("hosted-oauth-loading")).toBeInTheDocument();
    });

    expect(window.location.pathname).toBe("/servers");
    expect(screen.queryByTestId("app-builder-tab")).not.toBeInTheDocument();
    expect(screen.queryByText("Servers Tab")).not.toBeInTheDocument();
  });

  it("does not hijack a non-default hash route for first-run guests", async () => {
    clearHostedOAuthPendingState();
    clearChatboxSession();
    mockUnseenOnboardingState();
    window.history.replaceState({}, "", "/tools");
    mockHandleOAuthCallback.mockReset();
    mockHostedShellGateState.value = "ready";
    mockWorkOsAuthState.user = null;
    mockFreshGuestUser();

    render(<App />);

    await waitFor(() => {
      expect(window.location.pathname).toBe("/tools");
    });

    expect(screen.queryByTestId("app-builder-tab")).not.toBeInTheDocument();
  });

  it("does not let localStorage hide NUX for a fresh guest user row", async () => {
    clearHostedOAuthPendingState();
    clearChatboxSession();
    localStorage.setItem(
      "mcp-onboarding-state",
      JSON.stringify({ status: "seen", shownAt: Date.now() })
    );
    window.history.replaceState({}, "", "/servers");
    mockHandleOAuthCallback.mockReset();
    mockHostedShellGateState.value = "ready";
    mockWorkOsAuthState.user = null;
    mockFreshGuestUser();

    render(<App />);

    await waitFor(() => {
      expect(screen.getByTestId("app-builder-tab")).toBeInTheDocument();
    });

    expect(window.location.pathname).toBe("/app-builder");
    expect(screen.queryByText("Servers Tab")).not.toBeInTheDocument();
  });

  it("does not auto-route signed-in users into App Builder once startup is ready", async () => {
    clearHostedOAuthPendingState();
    clearChatboxSession();
    window.history.replaceState({}, "", "/servers");
    mockHandleOAuthCallback.mockReset();
    mockWorkOsAuthState.user = { id: "user-1" };

    render(<App />);

    await waitFor(() => {
      expect(screen.getByText("Servers Tab")).toBeInTheDocument();
    });

    expect(window.location.pathname).toBe("/servers");
    expect(screen.queryByTestId("app-builder-tab")).not.toBeInTheDocument();
  });

  it("keeps Playground available when evaluate-runs is disabled", async () => {
    clearHostedOAuthPendingState();
    clearChatboxSession();
    window.history.replaceState({}, "", "/evals");
    mockHandleOAuthCallback.mockReset();
    mockUseFeatureFlagEnabled.mockImplementation(
      (flag: string) => flag === "playground-enabled"
    );

    render(<App />);

    await waitFor(() => {
      expect(screen.getByTestId("evals-tab")).toBeInTheDocument();
    });

    expect(window.location.pathname).toBe("/evals");
    expect(screen.queryByTestId("ci-evals-tab")).not.toBeInTheDocument();
  });

  it("waits on ci-evals while the evaluate-runs flag is still loading", async () => {
    clearHostedOAuthPendingState();
    clearChatboxSession();
    window.history.replaceState({}, "", "/ci-evals");
    mockHandleOAuthCallback.mockReset();

    const evaluateRunsState: { value: boolean | undefined } = {
      value: undefined,
    };
    mockPosthogState.featureFlags.hasLoadedFlags = false;
    mockUseFeatureFlagEnabled.mockImplementation((flag: string) =>
      flag === "evaluate-runs"
        ? evaluateRunsState.value
        : flag === "playground-enabled"
    );

    render(<App />);

    expect(window.location.pathname).toBe("/ci-evals");
    expect(screen.getByText("Loading Runs...")).toBeInTheDocument();
    expect(screen.queryByTestId("evals-tab")).not.toBeInTheDocument();

    act(() => {
      mockPosthogState.featureFlags.hasLoadedFlags = true;
      evaluateRunsState.value = true;
      mockPosthogState.emitFeatureFlags();
    });

    await waitFor(() => {
      expect(screen.getByTestId("ci-evals-tab")).toBeInTheDocument();
    });

    expect(window.location.pathname).toBe("/ci-evals");
    expect(screen.queryByText("Loading Runs...")).not.toBeInTheDocument();
  });

  it("redirects ci-evals to Playground when evaluate-runs is disabled", async () => {
    clearHostedOAuthPendingState();
    clearChatboxSession();
    window.history.replaceState({}, "", "/ci-evals");
    mockHandleOAuthCallback.mockReset();

    mockPosthogState.featureFlags.hasLoadedFlags = false;
    mockUseFeatureFlagEnabled.mockImplementation((flag: string) =>
      flag === "evaluate-runs" ? undefined : flag === "playground-enabled"
    );

    render(<App />);

    expect(screen.getByText("Loading Runs...")).toBeInTheDocument();

    act(() => {
      mockPosthogState.featureFlags.hasLoadedFlags = true;
      mockPosthogState.emitFeatureFlags();
    });

    await waitFor(() => {
      expect(screen.getByTestId("evals-tab")).toBeInTheDocument();
    });

    expect(window.location.pathname).toBe("/evals");
    expect(screen.queryByTestId("ci-evals-tab")).not.toBeInTheDocument();
  });

  it("redirects nested ci-evals routes to Playground when evaluate-runs is disabled", async () => {
    clearHostedOAuthPendingState();
    clearChatboxSession();
    window.history.replaceState({}, "", "/ci-evals/suite/s_123?view=runs");
    mockHandleOAuthCallback.mockReset();

    mockUseFeatureFlagEnabled.mockImplementation((flag: string) =>
      flag === "evaluate-runs" ? undefined : flag === "playground-enabled"
    );

    render(<App />);

    await waitFor(() => {
      expect(screen.getByTestId("evals-tab")).toBeInTheDocument();
    });

    expect(window.location.pathname).toBe("/evals");
    expect(screen.queryByTestId("ci-evals-tab")).not.toBeInTheDocument();
  });

  it("redirects conformance to servers when the feature flag is disabled", async () => {
    clearHostedOAuthPendingState();
    clearChatboxSession();
    window.history.replaceState({}, "", "/conformance");
    mockHandleOAuthCallback.mockReset();

    mockUseFeatureFlagEnabled.mockImplementation(
      (flag: string) => flag === "playground-enabled"
    );

    render(<App />);

    await waitFor(() => {
      expect(window.location.pathname).toBe("/servers");
    });
  });

  it("redirects xaa-flow to Servers when the xaa flag is disabled", async () => {
    clearHostedOAuthPendingState();
    clearChatboxSession();
    window.history.replaceState({}, "", "/xaa-flow");
    mockHandleOAuthCallback.mockReset();

    render(<App />);

    await waitFor(() => {
      expect(screen.getByText("Servers Tab")).toBeInTheDocument();
    });

    expect(window.location.pathname).toBe("/servers");
    expect(screen.queryByTestId("xaa-flow-tab")).not.toBeInTheDocument();
  });

  it("renders xaa-flow when the xaa flag is enabled", async () => {
    clearHostedOAuthPendingState();
    clearChatboxSession();
    window.history.replaceState({}, "", "/xaa-flow");
    mockHandleOAuthCallback.mockReset();
    mockUseFeatureFlagEnabled.mockImplementation((flag: string) =>
      flag === "xaa" ? true : false
    );

    render(<App />);

    await waitFor(() => {
      expect(screen.getByTestId("xaa-flow-tab")).toBeInTheDocument();
    });

    expect(window.location.pathname).toBe("/xaa-flow");
    expect(screen.queryByText("Servers Tab")).not.toBeInTheDocument();
  });

  it("passes OAuth-only project server selector props on the XAA Debugger tab", async () => {
    clearHostedOAuthPendingState();
    clearChatboxSession();
    window.history.replaceState({}, "", "/xaa-flow");
    mockHandleOAuthCallback.mockReset();
    mockUseFeatureFlagEnabled.mockImplementation((flag: string) =>
      flag === "xaa" ? true : false
    );
    const appStateMock = createAppStateMock();
    const currentProjectServers = {
      "current-project-xaa-oauth": {
        name: "current-project-xaa-oauth",
        config: { url: "https://current-xaa.example/mcp" },
        connectionStatus: "connected",
        enabled: true,
        retryCount: 0,
        useOAuth: true,
        lastConnectionTime: new Date("2024-01-01"),
      },
    };
    appStateMock.projectServers = currentProjectServers;
    appStateMock.appState.servers = {
      ...currentProjectServers,
      "other-project-xaa-oauth": {
        name: "other-project-xaa-oauth",
        config: { url: "https://other-xaa.example/mcp" },
        connectionStatus: "connected",
        enabled: true,
        retryCount: 0,
        useOAuth: true,
        lastConnectionTime: new Date("2024-01-02"),
      },
    };
    mockUseAppState.mockImplementation(() => appStateMock);

    render(<App />);

    await waitFor(() => {
      expect(mockHeader).toHaveBeenCalledWith(
        expect.objectContaining({
          activeServerSelectorProps: expect.objectContaining({
            showOnlyOAuthServers: true,
            autoSelectFilteredServer: false,
          }),
        })
      );
    });

    const latestProps = mockHeader.mock.calls.at(-1)?.[0] as {
      activeServerSelectorProps?: { serverConfigs?: unknown };
    };
    expect(latestProps.activeServerSelectorProps?.serverConfigs).toBe(
      currentProjectServers
    );
  });

  it("passes OAuth-only server selector props on the OAuth Debugger tab", async () => {
    clearHostedOAuthPendingState();
    clearChatboxSession();
    window.history.replaceState({}, "", "/oauth-flow");
    mockHandleOAuthCallback.mockReset();
    const appStateMock = createAppStateMock();
    const currentProjectServers = {
      "current-project-oauth": {
        name: "current-project-oauth",
        config: { url: "https://current.example/mcp" },
        connectionStatus: "connected",
        enabled: true,
        retryCount: 0,
        useOAuth: true,
        lastConnectionTime: new Date("2024-01-01"),
      },
    };
    appStateMock.projectServers = currentProjectServers;
    appStateMock.appState.servers = {
      ...currentProjectServers,
      "other-project-oauth": {
        name: "other-project-oauth",
        config: { url: "https://other.example/mcp" },
        connectionStatus: "connected",
        enabled: true,
        retryCount: 0,
        useOAuth: true,
        lastConnectionTime: new Date("2024-01-02"),
      },
    };
    mockUseAppState.mockImplementation(() => appStateMock);

    render(<App />);

    await waitFor(() => {
      expect(mockHeader).toHaveBeenCalledWith(
        expect.objectContaining({
          activeServerSelectorProps: expect.objectContaining({
            showOnlyOAuthServers: true,
            autoSelectFilteredServer: false,
          }),
        })
      );
    });

    const latestProps = mockHeader.mock.calls.at(-1)?.[0] as {
      activeServerSelectorProps?: { serverConfigs?: unknown };
    };
    expect(latestProps.activeServerSelectorProps?.serverConfigs).toBe(
      currentProjectServers
    );
  });

  it("leaves the header server selector unfiltered outside the OAuth Debugger tab", async () => {
    clearHostedOAuthPendingState();
    clearChatboxSession();
    window.history.replaceState({}, "", "/tools");
    mockHandleOAuthCallback.mockReset();

    render(<App />);

    await waitFor(() => {
      expect(mockHeader).toHaveBeenCalledWith(
        expect.objectContaining({
          activeServerSelectorProps: expect.objectContaining({
            showOnlyOAuthServers: false,
            autoSelectFilteredServer: true,
          }),
        })
      );
    });
  });

  it("still applies the CI billing redirect when evaluate-runs is enabled", async () => {
    clearHostedOAuthPendingState();
    clearChatboxSession();
    window.history.replaceState({}, "", "/ci-evals");
    mockHandleOAuthCallback.mockReset();
    mockUseAppState.mockImplementation(() => ({
      ...createAppStateMock(),
      isCloudSyncActive: true,
      projects: {
        ws_local: {
          id: "ws_local",
          name: "Project One",
          sharedProjectId: "shared-ws-1",
          organizationId: "org-1",
          servers: {},
          createdAt: new Date(),
          updatedAt: new Date(),
        },
      },
    }));
    mockUseFeatureFlagEnabled.mockImplementation(
      (flag: string) =>
        flag === "billing-entitlements-ui" || flag === "evaluate-runs"
    );
    mockUseQuery.mockImplementation((name: string) => {
      if (name === "users:getCurrentUser") {
        return existingConvexUser;
      }

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

      if (name === "billing:getProjectPremiumness") {
        return {
          plan: "free",
          enforcementState: "active",
          effectivePlan: "free",
          billingInterval: null,
          source: "free",
          decisionRequired: false,
          gates: [
            {
              gateKey: "cicd",
              kind: "feature",
              scope: "organization",
              canAccess: false,
              shouldShowUpsell: true,
              upgradePlan: "team",
              reason: "feature_not_included",
            },
          ],
        };
      }

      return undefined;
    });

    render(<App />);

    const wsPremiumnessCall = mockUseQuery.mock.calls.find(
      ([name]) => name === "billing:getProjectPremiumness"
    );

    expect(wsPremiumnessCall?.[1]).toEqual({
      organizationId: "org-1",
      projectId: "shared-ws-1",
    });

    await waitFor(() => {
      expect(screen.getByText("Servers Tab")).toBeInTheDocument();
    });

    expect(window.location.pathname).toBe("/servers");
    expect(screen.queryByTestId("evals-tab")).not.toBeInTheDocument();
  });
});
