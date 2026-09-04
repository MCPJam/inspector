import { type ReactNode, useLayoutEffect, useState } from "react";
import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { toast as sonnerToast } from "sonner";
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
  clearScenarioSession,
  readScenarioSignInReturnPath,
  writeScenarioSignInReturnPath,
  writeScenarioSession,
} from "../lib/scenario-session";
import { writeAppSignInReturnPath } from "../lib/app-signin-return-path";

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
  mockPlaygroundTabMounts,
  mockPlaygroundTabProps,
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
  mockTrack,
  mockUserTestingTab,
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
    areServersHydrated: true,
    projectServers: {},
    displayServerConfigs: {},
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
    mockPlaygroundTabMounts: vi.fn(),
    mockPlaygroundTabProps: vi.fn(),
    mockConvexAuthState: {
      isAuthenticated: true,
      isLoading: false,
    },
    mockCompleteHostedOAuthCallback: vi.fn(),
    mockHandleOAuthCallback: vi.fn(),
    mockHostedShellGateState: {
      value: "ready" as
        "ready" | "auth-loading" | "project-loading" | "logged-out",
    },
    mockMCPSidebar: vi.fn(() => <div />),
    mockOAuthFlowTabState: {
      shouldThrow: false,
      error: new Error("OAuth debugger failed"),
      lastProps: undefined as unknown,
    },
    mockOrganizationsTab: vi.fn(() => <div />),
    mockPosthogCapture: vi.fn(),
    mockTrack: vi.fn(),
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
    mockUserTestingTab: vi.fn(() => <div>User Testing Tab</div>),
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
      : undefined,
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
      : undefined,
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
  // Hooks like useScenarioBackfillForProject call the returned mutation as
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
  // MCPJamLimitDialog (mounted app-wide) reads the guest credit-wall variant.
  // These tests don't exercise that wall, so control (undefined) is fine.
  useFeatureFlagVariantKey: () => undefined,
}));

vi.mock("@/lib/analytics", () => ({
  track: mockTrack,
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

vi.mock("../contexts/db-user-ready-context", () => ({
  useDbUserBootstrapStatus: vi.fn(() => ({
    isEnsuringUser: false,
    isUserReady: true,
  })),
  useDbUserReady: vi.fn(() => true),
}));

vi.mock("../hooks/usePostHogIdentify", () => ({
  usePostHogIdentify: vi.fn(),
}));

vi.mock("../hooks/usePostHogOrgContext", () => ({
  usePostHogOrgContext: vi.fn(),
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
  // Literal rather than the real export: the module under mock is the one
  // being stubbed out. Drift is caught by the ratchet in
  // lib/oauth/__tests__/oauth-callback-recovery.test.ts, which pins the
  // constant to this exact value.
  OAUTH_PENDING_STORAGE_KEY: "mcp-oauth-pending",
  completeHostedOAuthCallback: mockCompleteHostedOAuthCallback,
  hasOAuthConfig: vi.fn(() => false),
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

vi.mock("../components/HomeTab", () => ({
  HomeTab: () => <div data-testid="home-tab" />,
}));
vi.mock("../components/ServersTab", () => ({
  ServersTab: () => <div>Servers Tab</div>,
}));
// Signed-in users get the Hosts hub at /servers (and /clients); the real
// component embeds the legacy Servers tab as its `serversTabElement` view, so
// the mock passes it through to keep "Servers Tab" queries meaningful.
vi.mock("../components/HostsTab", () => ({
  HostsTab: ({ serversTabElement }: { serversTabElement?: ReactNode }) => (
    <div data-testid="hosts-tab">{serversTabElement}</div>
  ),
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
vi.mock("../components/UserTestingTab", () => ({
  UserTestingTab: (props: unknown) => mockUserTestingTab(props),
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
vi.mock("../components/OAuthFlowTab", () => ({
  OAuthFlowTab: (props: unknown) => {
    mockOAuthFlowTabState.lastProps = props;
    if (mockOAuthFlowTabState.shouldThrow) {
      throw mockOAuthFlowTabState.error;
    }
    return <div data-testid="oauth-flow-tab" />;
  },
}));
vi.mock("../components/xaa/XAAFlowTab", () => ({
  XAAFlowTab: () => <div data-testid="xaa-flow-tab">XAA Debugger Tab</div>,
}));
vi.mock("../components/playground/PlaygroundTab", () => ({
  PlaygroundTab: (props: {
    onOnboardingChange?: (value: boolean) => void;
    isSignedInWithWorkOs?: boolean;
    isWorkOsAuthLoading?: boolean;
    isConvexAuthenticated?: boolean;
    hasSeenFirstRunOnboarding?: boolean;
  }) => {
    mockPlaygroundTabProps(props);
    const { onOnboardingChange } = props;

    useLayoutEffect(() => {
      mockPlaygroundTabMounts();
      onOnboardingChange?.(true);
      return () => onOnboardingChange?.(false);
    }, [onOnboardingChange]);

    return (
      <div data-testid="playground-tab">
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
  useSidebar: () => ({ isMobile: false }),
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
vi.mock("../components/ActiveHostServerReconciler", () => ({
  ActiveHostServerReconciler: () => null,
}));
vi.mock("@mcpjam/design-system/sonner", () => ({
  Toaster: () => <div />,
}));
vi.mock("../state/app-state-context", () => ({
  AppStateProvider: ({ children }: { children?: ReactNode }) => (
    <div>{children}</div>
  ),
  // ActiveHostServerReconciler reads this via useAutoConnectProjectServers
  // to compute connected/excess servers. Return an empty servers map so
  // the reconciler's reconciliation logic is a no-op in App-level tests.
  useSharedAppState: () => ({ servers: {} }),
  useOptionalSharedAppState: () => ({ servers: {} }),
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
vi.mock("../components/hosted/ScenarioChatPage", () => ({
  ScenarioChatPage: () => <button type="button">Authorize</button>,
  getScenarioPathTokenFromLocation: () => null,
}));

describe("App hosted OAuth callback handling", () => {
  beforeEach(() => {
    clearHostedOAuthPendingState();
    clearScenarioSession();
    localStorage.clear();
    localStorage.setItem(
      "mcp-onboarding-state",
      JSON.stringify({ status: "completed", completedAt: Date.now() }),
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
      ref === "users:getCurrentUser" ? existingConvexUser : undefined,
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
    mockUserTestingTab.mockReset();
    mockUserTestingTab.mockImplementation(() => <div>User Testing Tab</div>);
    mockHeader.mockReset();
    mockHeader.mockImplementation((_props: unknown) => (
      <div data-testid="app-header" />
    ));
    mockMCPSidebar.mockReset();
    mockMCPSidebar.mockImplementation(() => <div data-testid="mcp-sidebar" />);
    mockOAuthFlowTabState.shouldThrow = false;
    mockOAuthFlowTabState.error = new Error("OAuth debugger failed");
    mockOAuthFlowTabState.lastProps = undefined;
    mockPosthogCapture.mockReset();
    mockTrack.mockReset();
    vi.mocked(sonnerToast.error).mockReset();
    mockPlaygroundTabMounts.mockReset();
    mockPlaygroundTabProps.mockReset();
    mockCompleteHostedOAuthCallback.mockImplementation(
      () => new Promise<never>(() => {}),
    );
    mockHandleOAuthCallback.mockImplementation(
      () => new Promise<never>(() => {}),
    );

    writeScenarioSession({
      scenarioId: "sbx_1",
      accessVersion: 1,
      payload: {
        projectId: "ws_1",
        scenarioId: "sbx_1",
        name: "Asaan",
        description: "Hosted scenario",
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
      surface: "scenario",
      projectId: "ws_1",
      serverId: "srv_asana",
      sessionId: "hosted-session-1",
      accessScope: "chat_v2",
      scenarioId: "sbx_1",
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
      screen.queryByRole("button", { name: "Authorize" }),
    ).not.toBeInTheDocument();
    await waitFor(() => {
      expect(mockCompleteHostedOAuthCallback).toHaveBeenCalledWith(
        expect.objectContaining({
          surface: "scenario",
          serverName: "asana",
        }),
        "oauth-code",
        expect.objectContaining({
          onTraceUpdate: expect.any(Function),
        }),
      );
    });
  });

  it("captures and copies sanitized OAuth Debugger boundary errors", async () => {
    clearHostedOAuthPendingState();
    clearScenarioSession();
    localStorage.clear();
    sessionStorage.clear();
    window.history.replaceState({}, "", "/oauth-flow");
    mockOAuthFlowTabState.shouldThrow = true;
    mockOAuthFlowTabState.error = new Error(
      "token exchange failed client_secret=super-secret Bearer access-token",
    );
    const writeText = vi.fn().mockResolvedValue(undefined);
    vi.stubGlobal("navigator", {
      ...window.navigator,
      clipboard: { writeText },
    });

    render(<App />);

    expect(
      await screen.findByText("OAuth Debugger crashed"),
    ).toBeInTheDocument();
    expect(mockTrack).toHaveBeenCalledWith(
      "oauth_debugger_error_boundary",
      expect.objectContaining({
        message: expect.stringContaining("[redacted]"),
      }),
    );
    expect(JSON.stringify(mockTrack.mock.calls)).not.toContain("super-secret");

    fireEvent.click(screen.getByRole("button", { name: /copy details/i }));

    await waitFor(() => {
      expect(writeText).toHaveBeenCalledWith(
        expect.not.stringContaining("super-secret"),
      );
    });
    expect(writeText.mock.calls[0]?.[0]).toContain("[redacted]");
  });

  it("uses hosted completion for guest scenario session callbacks", async () => {
    mockConvexAuthState.isAuthenticated = false;

    render(<App />);

    await waitFor(() => {
      expect(mockHandleOAuthCallback).not.toHaveBeenCalled();
      expect(mockCompleteHostedOAuthCallback).toHaveBeenCalledWith(
        expect.objectContaining({
          surface: "scenario",
          projectId: "ws_1",
          serverId: "srv_asana",
          sessionId: "hosted-session-1",
          scenarioId: "sbx_1",
        }),
        "oauth-code",
        expect.objectContaining({
          authorizationHeader: "Bearer guest-bearer",
          onTraceUpdate: expect.any(Function),
        }),
      );
    });
  });

  it("uses hosted completion for authenticated scenario callbacks without a hosted session id", async () => {
    clearHostedOAuthPendingState();
    writeHostedOAuthPendingMarker({
      surface: "scenario",
      projectId: "ws_1",
      serverId: "srv_asana",
      accessScope: "chat_v2",
      scenarioId: "sbx_1",
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
          surface: "scenario",
          projectId: "ws_1",
          serverId: "srv_asana",
          sessionId: null,
          scenarioId: "sbx_1",
        }),
        "oauth-code",
        expect.objectContaining({
          authorizationHeader: undefined,
          onTraceUpdate: expect.any(Function),
        }),
      );
    });
  });

  it("reports a clear guest session error when a scenario callback bearer is unavailable", async () => {
    mockConvexAuthState.isAuthenticated = false;
    mockGetGuestBearerToken.mockResolvedValue(null);

    render(<App />);

    await waitFor(() => {
      expect(readHostedOAuthResumeMarker("scenario")?.errorMessage).toBe(
        "Your guest session expired. Reopen the swarm link and try again.",
      );
    });
    expect(mockCompleteHostedOAuthCallback).not.toHaveBeenCalled();
    expect(mockHandleOAuthCallback).not.toHaveBeenCalled();
  });

  it("attaches the WorkOS bearer when a signed-in user returns to a scenario callback", async () => {
    // Regression for the scenario OAuth 403: on scenario routes useApiContext is
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
          surface: "scenario",
          scenarioId: "sbx_1",
        }),
        "oauth-code",
        expect.objectContaining({
          authorizationHeader: "Bearer workos-token",
          onTraceUpdate: expect.any(Function),
        }),
      );
    });
    expect(mockGetGuestBearerToken).not.toHaveBeenCalled();
  });

  it("does not keep the hosted loading screen for project OAuth callbacks", async () => {
    clearHostedOAuthPendingState();
    clearScenarioSession();
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
      screen.queryByTestId("hosted-oauth-loading"),
    ).not.toBeInTheDocument();
    expect(screen.getByTestId("hosts-tab")).toBeInTheDocument();
    expect(screen.getByText("Servers Tab")).toBeInTheDocument();

    await waitFor(() => {
      expect(mockCompleteHostedOAuthCallback).not.toHaveBeenCalled();
    });
  });

  it("escapes a stale queryless callback page back to the root shell", async () => {
    clearHostedOAuthPendingState();
    clearScenarioSession();
    localStorage.removeItem("mcp-oauth-pending");
    localStorage.removeItem("mcp-serverUrl-asana");
    window.history.replaceState({}, "", "/callback");
    writeScenarioSignInReturnPath("/user-testing/asana/token-123");
    mockConvexAuthState.isAuthenticated = false;
    mockConvexAuthState.isLoading = false;
    mockWorkOsAuthState.user = null;
    mockWorkOsAuthState.isLoading = false;

    render(<App />);

    await waitFor(() => {
      expect(window.location.pathname).toBe("/");
    });

    expect(
      screen.queryByTestId("callback-auth-timeout"),
    ).not.toBeInTheDocument();
    expect(mockWorkOsAuthState.signIn).not.toHaveBeenCalled();
    expect(readScenarioSignInReturnPath()).toBe(
      "/user-testing/asana/token-123",
    );
  });

  it("clears stale client auth state before retrying a timed-out callback", async () => {
    vi.useFakeTimers();

    try {
      clearHostedOAuthPendingState();
      clearScenarioSession();
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
        }),
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
        screen.getByRole("button", { name: "Try sign in again" }),
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
      ([name]) => name === "billing:getOrganizationEntitlements",
    );
    const orgPremiumnessCall = mockUseQuery.mock.calls.find(
      ([name]) => name === "billing:getOrganizationPremiumness",
    );
    const wsPremiumnessCall = mockUseQuery.mock.calls.find(
      ([name]) => name === "billing:getProjectPremiumness",
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
      ([name]) => name === "billing:getOrganizationEntitlements",
    );
    const orgPremiumnessCall = mockUseQuery.mock.calls.find(
      ([name]) => name === "billing:getOrganizationPremiumness",
    );
    const wsPremiumnessCall = mockUseQuery.mock.calls.find(
      ([name]) => name === "billing:getProjectPremiumness",
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
      ([name]) => name === "billing:getProjectPremiumness",
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
      ([name]) => name === "billing:getProjectPremiumness",
    );

    expect(wsPremiumnessCall?.[1]).toBe("skip");
    await waitFor(() => {
      expect(clearConvexActiveProjectSelection).toHaveBeenCalled();
    });
  });

  // (Removed) "passes a billing-safe project id to the scenarios tab" —
  // the old test asserted that ScenariosTab received
  // `{ projectId: null, organizationId, isBillingContextPending }` when
  // cloud sync was off, gating the org-scoped billing gate. After the
  // 1:1 host↔scenario consolidation the tab signature is just
  // `{ projectId, isAuthenticated }` (no org / billing props), and the
  // ScenariosRoute forwards the route-context `convexProjectId` whether
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
          surface: "scenario",
          serverName: "asana",
        }),
        "oauth-code",
        expect.objectContaining({
          onTraceUpdate: expect.any(Function),
        }),
      );
    });

    expect(setActiveOrganizationId).not.toHaveBeenCalled();
  });

  it("passes the valid organization route into app state for project actions", async () => {
    clearHostedOAuthPendingState();
    clearScenarioSession();
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
    clearScenarioSession();
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
    clearScenarioSession();
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
    clearScenarioSession();
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

  it("lands on servers when switching active organization from org models", async () => {
    clearHostedOAuthPendingState();
    clearScenarioSession();
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
      expect(window.location.pathname).toBe("/servers");
    });
  });

  it("keeps sidebar project creation enabled for uncapped free routed orgs", async () => {
    clearHostedOAuthPendingState();
    clearScenarioSession();
    window.history.replaceState({}, "", "/organizations/org-3");
    mockUseFeatureFlagEnabled.mockImplementation(
      (flag: string) => flag === "billing-entitlements-ui",
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
              canAccess: true,
              shouldShowUpsell: false,
              upgradePlan: null,
              reason: "within_limit",
              currentValue: 1,
              allowedValue: null,
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
    expect(lastCall?.[0].isCreateProjectDisabled).toBe(false);
    expect(lastCall?.[0].createProjectDisabledReason).toBeUndefined();
  });

  it("shows billing handoff loading and triggers sign-in for guest billing entry", async () => {
    clearHostedOAuthPendingState();
    clearScenarioSession();
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
    clearScenarioSession();
    sessionStorage.clear();
    persistCheckoutIntent({ plan: "team", interval: "annual" });
    writeBillingSignInReturnPath("/billing");
    window.history.replaceState({}, "", "/callback?code=oauth-code");

    mockUseFeatureFlagEnabled.mockImplementation(
      (flag: string) => flag === "billing-entitlements-ui",
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
    clearScenarioSession();
    sessionStorage.clear();
    writeBillingSignInReturnPath("/billing");
    window.history.replaceState({}, "", "/callback?code=oauth-code");

    const replaceStateSpy = vi.spyOn(window.history, "replaceState");

    render(<App />);

    await waitFor(() => {
      expect(replaceStateSpy).toHaveBeenCalledWith({}, "", "/");
      // The restoration NAVIGATES now rather than writing history behind the
      // router's back, so the screen follows the URL it just restored: `/`
      // is Home. (It used to leave the app rendering Servers under a `/` it
      // had silently rewritten — the mismatch this migration removes.)
      expect(screen.getByTestId("home-tab")).toBeInTheDocument();
    });
    expect(readBillingSignInReturnPath()).toBeNull();
  });

  it("recovers a stale scoped sign-in return without painting the unavailable screen", async () => {
    clearScenarioSession();
    const staleProjectId = "k5700000000000000000000000a";
    const currentProjectId = "k5700000000000000000000000b";
    const stalePath = `/p/${staleProjectId}/evals?view=runs#case-3`;
    writeAppSignInReturnPath(stalePath);
    window.history.replaceState({}, "", "/callback?code=oauth-code");
    mockUseAppState.mockImplementation(() => ({
      ...createAppStateMock(),
      activeProjectId: currentProjectId,
      projects: {
        [currentProjectId]: {
          id: currentProjectId,
          name: "Default Project",
          sharedProjectId: currentProjectId,
          organizationId: "org-1",
          servers: {},
          createdAt: new Date(),
          updatedAt: new Date(),
        },
      },
    }));
    mockUseQuery.mockImplementation((name: string) => {
      if (name === "users:getCurrentUser") return existingConvexUser;
      if (name === "projects:getMyProjects") {
        return [
          {
            _id: currentProjectId,
            name: "Default Project",
            organizationId: "org-1",
            ownerId: "user-1",
            servers: {},
            createdAt: 1,
            updatedAt: 1,
          },
        ];
      }
      return undefined;
    });

    render(<App />);

    await waitFor(() => {
      expect(`${window.location.pathname}${window.location.search}`).toBe(
        `/p/${currentProjectId}/evals?view=runs`,
      );
      expect(window.location.hash).toBe("#case-3");
    });
    expect(
      screen.queryByTestId("project-route-inaccessible"),
    ).not.toBeInTheDocument();
    expect(sonnerToast.error).toHaveBeenCalledTimes(1);
    expect(vi.mocked(sonnerToast.error).mock.calls[0]?.[0]).toMatchObject({
      props: { text: "Project not found. Switched to Default Project." },
    });
    expect(mockTrack).toHaveBeenCalledWith(
      "project_route_stale_return_recovered",
      { location: "signin-return", outcome: "switched" },
    );
    expect(mockTrack).not.toHaveBeenCalledWith(
      "project_route_inaccessible",
      expect.anything(),
    );
  });

  it("keeps a persisted billing resume alive when /billing returns without query params", async () => {
    clearHostedOAuthPendingState();
    clearScenarioSession();
    sessionStorage.clear();
    persistCheckoutIntent({ plan: "team", interval: "annual" });
    window.history.replaceState({}, "", "/billing");

    mockUseFeatureFlagEnabled.mockImplementation(
      (flag: string) => flag === "billing-entitlements-ui",
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
            ?.interval === "annual",
      ),
    ).toBe(true);
  });

  it("prefers scenario callback restoration over billing callback restoration", async () => {
    clearHostedOAuthPendingState();
    clearScenarioSession();
    sessionStorage.clear();
    persistCheckoutIntent({ plan: "team", interval: "annual" });
    writeBillingSignInReturnPath("/billing");
    writeScenarioSignInReturnPath("/user-testing/demo/token-123");
    window.history.replaceState({}, "", "/callback?code=oauth-code");

    const replaceStateSpy = vi.spyOn(window.history, "replaceState");

    render(<App />);

    await waitFor(() => {
      expect(replaceStateSpy).toHaveBeenCalledWith(
        {},
        "",
        "/user-testing/demo/token-123",
      );
    });
  });

  it("keeps billing resume behind the checkout spinner for signed-in users", async () => {
    clearHostedOAuthPendingState();
    clearScenarioSession();
    window.history.replaceState({}, "", "/billing?plan=team&interval=annual");

    mockUseFeatureFlagEnabled.mockImplementation(
      (flag: string) => flag === "billing-entitlements-ui",
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
            ?.interval === "annual",
      ),
    ).toBe(true);
  });

  it("drops the billing overlay when checkout intent is consumed", async () => {
    clearHostedOAuthPendingState();
    clearScenarioSession();
    window.history.replaceState({}, "", "/billing?plan=team&interval=annual");

    mockUseFeatureFlagEnabled.mockImplementation(
      (flag: string) => flag === "billing-entitlements-ui",
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
      ),
    );

    render(<App />);

    await waitFor(() => {
      expect(screen.getByTestId("billing-handoff-overlay")).toBeInTheDocument();
      expect(screen.getByTestId("consume-checkout-intent")).toBeInTheDocument();
    });

    fireEvent.click(screen.getByTestId("consume-checkout-intent"));

    await waitFor(() => {
      expect(
        screen.queryByTestId("billing-handoff-overlay"),
      ).not.toBeInTheDocument();
    });
  });

  it("drops the billing overlay when checkout navigation starts", async () => {
    clearHostedOAuthPendingState();
    clearScenarioSession();
    window.history.replaceState({}, "", "/billing?plan=team&interval=annual");

    mockUseFeatureFlagEnabled.mockImplementation(
      (flag: string) => flag === "billing-entitlements-ui",
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
      ),
    );

    render(<App />);

    await waitFor(() => {
      expect(screen.getByTestId("billing-handoff-overlay")).toBeInTheDocument();
      expect(
        screen.getByTestId("start-checkout-navigation"),
      ).toBeInTheDocument();
    });

    fireEvent.click(screen.getByTestId("start-checkout-navigation"));

    await waitFor(() => {
      expect(
        screen.queryByTestId("billing-handoff-overlay"),
      ).not.toBeInTheDocument();
    });
    expect(readPersistedCheckoutIntent()).toBeNull();
  });

  it("clears billing handoff state when no organization is available", async () => {
    clearHostedOAuthPendingState();
    clearScenarioSession();
    window.history.replaceState({}, "", "/billing?plan=team&interval=annual");

    mockUseFeatureFlagEnabled.mockImplementation(
      (flag: string) => flag === "billing-entitlements-ui",
    );
    mockUseQuery.mockImplementation((name: string) => {
      if (name === "organizations:getMyOrganizations") {
        return [];
      }

      return undefined;
    });

    render(<App />);

    await waitFor(() => {
      expect(screen.getByTestId("home-tab")).toBeInTheDocument();
    });

    expect(
      screen.queryByTestId("billing-handoff-loading"),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByTestId("billing-handoff-overlay"),
    ).not.toBeInTheDocument();
    expect(mockOrganizationsTab).not.toHaveBeenCalled();
  });

  it("renders the organization route from the hash even before active org state catches up", async () => {
    clearHostedOAuthPendingState();
    clearScenarioSession();
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
    clearScenarioSession();
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
      ),
    );

    render(<App />);

    fireEvent.click(await screen.findByTestId("delete-org"));

    await waitFor(() => {
      expect(setActiveOrganizationId).toHaveBeenLastCalledWith("org-owned");
    });

    expect(clearConvexActiveProjectSelection).toHaveBeenCalled();
    expect(clearLocalFallbackProjectSelection).toHaveBeenCalledWith(
      "org-deleted",
      "org-owned",
    );
    expect(window.location.pathname).toBe("/servers");
  });

  it("falls back to the first remaining org when no owned org remains after delete", async () => {
    clearHostedOAuthPendingState();
    clearScenarioSession();
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
      ),
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
    clearScenarioSession();
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
      ),
    );

    render(<App />);

    const activeOrgCallsBeforeDelete =
      setActiveOrganizationId.mock.calls.length;
    fireEvent.click(await screen.findByTestId("delete-non-current-org"));

    await waitFor(() => {
      expect(clearLocalFallbackProjectSelection).toHaveBeenCalledWith(
        "org-deleted",
        "org-owner",
      );
    });

    const postDeleteCalls = setActiveOrganizationId.mock.calls.slice(
      activeOrgCallsBeforeDelete,
    );
    expect(postDeleteCalls).not.toContainEqual(["org-owner"]);
    expect(clearConvexActiveProjectSelection).not.toHaveBeenCalled();
    expect(window.location.pathname).toBe("/organizations/org-member");
  });

  it("clears org and synced project selection when deleting the last org", async () => {
    clearHostedOAuthPendingState();
    clearScenarioSession();
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
      ),
    );

    render(<App />);

    fireEvent.click(await screen.findByTestId("delete-last-org"));

    await waitFor(() => {
      expect(setActiveOrganizationId).toHaveBeenLastCalledWith(undefined);
    });

    expect(clearConvexActiveProjectSelection).toHaveBeenCalled();
    expect(clearLocalFallbackProjectSelection).toHaveBeenCalledWith(
      "org-deleted",
      undefined,
    );
    expect(window.location.pathname).toBe("/servers");
  });

  // (Removed) "still renders the scenarios tab when project premiumness
  // denies scenario creation" — scenario creation no longer happens on the
  // /scenarios tab (it's the publish surface for a host-bound scenario
  // that's created with the host). The test's premise — that the tab
  // has its own billing gate for creation — no longer exists, so the
  // test was deleted rather than rewritten.

  it("navigates back to the User Testing tab after callback completion", async () => {
    clearHostedOAuthPendingState();
    clearScenarioSession();
    writeHostedOAuthPendingMarker({
      surface: "scenario",
      projectId: "ws_1",
      serverId: "srv_asana",
      sessionId: "hosted-session-scenarios",
      accessScope: "chat_v2",
      scenarioId: "sbx_1",
      accessVersion: 1,
      serverName: "asana",
      serverUrl: "https://mcp.asana.com/sse",
      returnPath: "#scenarios",
    });
    // User Testing is flag-gated at the route, not just in the sidebar — the
    // callback can only land back on it for a user who has the flag.
    mockUseFeatureFlagEnabled.mockImplementation(
      (flag: string) => flag === "sandboxes-enabled",
    );
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
      // A legacy `#scenarios` return path resolves to the tab id `scenarios`,
      // whose canonical path is now `/user-testing`.
      expect(window.location.pathname).toBe("/user-testing");
      expect(screen.getByText("User Testing Tab")).toBeInTheDocument();
    });
    expect(screen.queryByText("Servers Tab")).not.toBeInTheDocument();
  });

  it("keeps Playground mounted when onboarding chrome is restored", async () => {
    clearHostedOAuthPendingState();
    clearScenarioSession();
    window.history.replaceState({}, "", "/playground");
    mockHandleOAuthCallback.mockReset();
    mockUseFeatureFlagEnabled.mockImplementation(
      (flag: string) => flag === "playground-enabled",
    );

    render(<App />);

    await waitFor(() => {
      expect(screen.getByTestId("playground-tab")).toBeInTheDocument();
    });

    expect(screen.queryByTestId("mcp-sidebar")).not.toBeInTheDocument();
    expect(screen.queryByTestId("app-header")).not.toBeInTheDocument();

    expect(mockPlaygroundTabMounts).toHaveBeenCalledTimes(1);

    fireEvent.click(screen.getByRole("button", { name: "Finish onboarding" }));

    await waitFor(() => {
      expect(screen.getByTestId("mcp-sidebar")).toBeInTheDocument();
      expect(screen.getByTestId("app-header")).toBeInTheDocument();
    });

    expect(mockPlaygroundTabMounts).toHaveBeenCalledTimes(1);
  });

  it("restores chrome after leaving Playground mid-onboarding", async () => {
    clearHostedOAuthPendingState();
    clearScenarioSession();
    window.history.replaceState({}, "", "/playground");
    mockHandleOAuthCallback.mockReset();
    mockUseFeatureFlagEnabled.mockImplementation(
      (flag: string) => flag === "playground-enabled",
    );

    render(<App />);

    await waitFor(() => {
      expect(screen.getByTestId("playground-tab")).toBeInTheDocument();
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

    expect(screen.queryByTestId("playground-tab")).not.toBeInTheDocument();
  });

  it("auto-routes a Convex-authenticated hosted guest into Playground onboarding once startup is ready", async () => {
    clearHostedOAuthPendingState();
    clearScenarioSession();
    mockUnseenOnboardingState();
    window.history.replaceState({}, "", "/servers");
    mockHandleOAuthCallback.mockReset();
    mockConvexAuthState.isAuthenticated = true;
    mockWorkOsAuthState.user = null;
    mockHostedShellGateState.value = "ready";
    mockFreshGuestUser();

    render(<App />);

    await waitFor(() => {
      expect(screen.getByTestId("playground-tab")).toBeInTheDocument();
    });

    expect(window.location.pathname).toBe("/playground");
    expect(screen.queryByText("Servers Tab")).not.toBeInTheDocument();
    expect(mockPlaygroundTabProps).toHaveBeenLastCalledWith(
      expect.objectContaining({
        isSignedInWithWorkOs: false,
        isWorkOsAuthLoading: false,
        isConvexAuthenticated: true,
        hasSeenFirstRunOnboarding: false,
      }),
    );
  });

  it("leaves an IdP-initiated visitor on /login instead of auto-routing to Playground", async () => {
    // Same first-run-eligible guest as the test above, at the WorkOS Initiate
    // Login URL. `/login` is not a known tab segment, so the shell resolves it
    // to the `servers` fallback — a first-run-eligible route — and a hosted
    // guest session IS Convex-authenticated. Without the guard in
    // `shouldRouteToFirstRunOnboarding`, the onboarding redirect fires on the
    // commit that mounts LoginInitiationRoute and navigates the visitor to
    // Playground mid-sign-in, stranding the enterprise entry point the route
    // exists to fix.
    //
    // Asserts the App-level half only: `render(<App />)` mounts no Router, so
    // the shell renders its no-router body rather than the route element. That
    // `signIn()` is what actually runs there is covered by
    // `components/auth/__tests__/login-initiation-route.test.tsx`.
    clearHostedOAuthPendingState();
    clearScenarioSession();
    mockUnseenOnboardingState();
    window.history.replaceState({}, "", "/login");
    mockHandleOAuthCallback.mockReset();
    mockConvexAuthState.isAuthenticated = true;
    mockWorkOsAuthState.user = null;
    mockHostedShellGateState.value = "ready";
    mockFreshGuestUser();

    render(<App />);

    await waitFor(() => {
      expect(screen.getByTestId("mcp-sidebar")).toBeInTheDocument();
    });

    expect(window.location.pathname).toBe("/login");
    expect(screen.queryByTestId("playground-tab")).not.toBeInTheDocument();
  });

  it("auto-routes a Convex-authenticated hosted guest from the default route into Playground onboarding", async () => {
    clearHostedOAuthPendingState();
    clearScenarioSession();
    mockUnseenOnboardingState();
    window.history.replaceState({}, "", "/");
    mockHandleOAuthCallback.mockReset();
    mockConvexAuthState.isAuthenticated = true;
    mockWorkOsAuthState.user = null;
    mockHostedShellGateState.value = "ready";
    mockFreshGuestUser();

    render(<App />);

    await waitFor(() => {
      expect(screen.getByTestId("playground-tab")).toBeInTheDocument();
    });

    expect(window.location.pathname).toBe("/playground");
    expect(screen.queryByTestId("home-tab")).not.toBeInTheDocument();
  });

  it("does not auto-route a guest row already marked as having seen onboarding", async () => {
    clearHostedOAuthPendingState();
    clearScenarioSession();
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
    expect(screen.queryByTestId("playground-tab")).not.toBeInTheDocument();
  });

  it("auto-routes an unseen guest when the only saved server is the incomplete first-run Excalidraw row", async () => {
    clearHostedOAuthPendingState();
    clearScenarioSession();
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
      expect(screen.getByTestId("playground-tab")).toBeInTheDocument();
    });

    expect(window.location.pathname).toBe("/playground");
  });

  it("does not auto-route to Playground when any saved server already exists", async () => {
    clearHostedOAuthPendingState();
    clearScenarioSession();
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
    expect(screen.queryByTestId("playground-tab")).not.toBeInTheDocument();
  });

  it("does not auto-route to Playground while the guest project is still provisioning", async () => {
    clearHostedOAuthPendingState();
    clearScenarioSession();
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
    expect(screen.queryByTestId("playground-tab")).not.toBeInTheDocument();
  });

  it("does not auto-route to Playground before hosted guest Convex auth is ready", async () => {
    clearHostedOAuthPendingState();
    clearScenarioSession();
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
    expect(screen.queryByTestId("playground-tab")).not.toBeInTheDocument();
  });

  it("does not auto-route to Playground while the hosted shell is still auth-loading", async () => {
    clearHostedOAuthPendingState();
    clearScenarioSession();
    mockUnseenOnboardingState();
    window.history.replaceState({}, "", "/servers");
    mockHandleOAuthCallback.mockReset();
    mockHostedShellGateState.value = "auth-loading";

    render(<App />);

    await waitFor(() => {
      expect(screen.getByTestId("hosted-oauth-loading")).toBeInTheDocument();
    });

    expect(window.location.pathname).toBe("/servers");
    expect(screen.queryByTestId("playground-tab")).not.toBeInTheDocument();
    expect(screen.queryByText("Servers Tab")).not.toBeInTheDocument();
  });

  it("does not flash Home while hosted auth is still loading on the default route", async () => {
    clearHostedOAuthPendingState();
    clearScenarioSession();
    mockUnseenOnboardingState();
    window.history.replaceState({}, "", "/");
    mockHandleOAuthCallback.mockReset();
    mockHostedShellGateState.value = "auth-loading";

    render(<App />);

    await waitFor(() => {
      expect(screen.getByTestId("hosted-oauth-loading")).toBeInTheDocument();
    });

    expect(window.location.pathname).toBe("/");
    expect(screen.queryByTestId("home-tab")).not.toBeInTheDocument();
    expect(screen.queryByTestId("playground-tab")).not.toBeInTheDocument();
  });

  it("does not flash Home while hosted guest auth is unresolved on the default route", async () => {
    clearHostedOAuthPendingState();
    clearScenarioSession();
    mockUnseenOnboardingState();
    window.history.replaceState({}, "", "/");
    mockHandleOAuthCallback.mockReset();
    mockHostedShellGateState.value = "ready";
    mockConvexAuthState.isAuthenticated = false;
    mockConvexAuthState.isLoading = false;
    mockWorkOsAuthState.user = null;

    render(<App />);

    await waitFor(() => {
      expect(screen.getByTestId("hosted-oauth-loading")).toBeInTheDocument();
    });

    expect(window.location.pathname).toBe("/");
    expect(screen.queryByTestId("home-tab")).not.toBeInTheDocument();
    expect(screen.queryByTestId("playground-tab")).not.toBeInTheDocument();
  });

  it("does not flash Home while hosted project and server state hydrate on the default route", async () => {
    clearHostedOAuthPendingState();
    clearScenarioSession();
    mockUnseenOnboardingState();
    window.history.replaceState({}, "", "/");
    mockHandleOAuthCallback.mockReset();
    mockHostedShellGateState.value = "ready";
    mockConvexAuthState.isAuthenticated = true;
    mockWorkOsAuthState.user = null;
    mockFreshGuestUser();
    mockUseAppState.mockImplementation(() => ({
      ...createAppStateMock(),
      isLoadingRemoteProjects: true,
      areServersHydrated: false,
      activeProjectId: "ws_local",
    }));

    render(<App />);

    await waitFor(() => {
      expect(screen.getByTestId("hosted-oauth-loading")).toBeInTheDocument();
    });

    expect(window.location.pathname).toBe("/");
    expect(screen.queryByTestId("home-tab")).not.toBeInTheDocument();
    expect(screen.queryByTestId("playground-tab")).not.toBeInTheDocument();
  });

  it("does not hijack a non-default hash route for first-run guests", async () => {
    clearHostedOAuthPendingState();
    clearScenarioSession();
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

    expect(screen.queryByTestId("playground-tab")).not.toBeInTheDocument();
  });

  it("does not let localStorage hide NUX for a fresh guest user row", async () => {
    clearHostedOAuthPendingState();
    clearScenarioSession();
    localStorage.setItem(
      "mcp-onboarding-state",
      JSON.stringify({ status: "seen", shownAt: Date.now() }),
    );
    window.history.replaceState({}, "", "/servers");
    mockHandleOAuthCallback.mockReset();
    mockHostedShellGateState.value = "ready";
    mockWorkOsAuthState.user = null;
    mockFreshGuestUser();

    render(<App />);

    await waitFor(() => {
      expect(screen.getByTestId("playground-tab")).toBeInTheDocument();
    });

    expect(window.location.pathname).toBe("/playground");
    expect(screen.queryByText("Servers Tab")).not.toBeInTheDocument();
  });

  it("does not auto-route signed-in users into Playground once startup is ready", async () => {
    clearHostedOAuthPendingState();
    clearScenarioSession();
    window.history.replaceState({}, "", "/servers");
    mockHandleOAuthCallback.mockReset();
    mockWorkOsAuthState.user = { id: "user-1" };

    render(<App />);

    await waitFor(() => {
      expect(screen.getByText("Servers Tab")).toBeInTheDocument();
    });

    expect(window.location.pathname).toBe("/servers");
    expect(screen.queryByTestId("playground-tab")).not.toBeInTheDocument();
  });

  it("renders Suites mode on /evals", async () => {
    clearHostedOAuthPendingState();
    clearScenarioSession();
    window.history.replaceState({}, "", "/evals");
    mockHandleOAuthCallback.mockReset();
    mockUseFeatureFlagEnabled.mockImplementation(
      (flag: string) => flag === "playground-enabled" || flag === "evaluate-ui",
    );

    render(<App />);

    await waitFor(() => {
      expect(screen.getByTestId("evals-tab")).toBeInTheDocument();
    });

    expect(window.location.pathname).toBe("/evals");
    expect(screen.queryByTestId("ci-evals-tab")).not.toBeInTheDocument();
  });

  it("renders Runs mode on /evals/runs with no flag gate", async () => {
    // Runs used to sit behind `evaluate-ci` at its own /ci-evals tab. It is a
    // mode under Evaluate now and ships to everyone, so there is no flag read,
    // no "Loading Runs..." spinner, and no redirect back to Suites.
    clearHostedOAuthPendingState();
    clearScenarioSession();
    window.history.replaceState({}, "", "/evals/runs");
    mockHandleOAuthCallback.mockReset();
    mockUseFeatureFlagEnabled.mockImplementation(
      (flag: string) => flag === "playground-enabled" || flag === "evaluate-ui",
    );

    render(<App />);

    await waitFor(() => {
      expect(screen.getByTestId("ci-evals-tab")).toBeInTheDocument();
    });

    expect(window.location.pathname).toBe("/evals/runs");
    expect(screen.queryByText("Loading Runs...")).not.toBeInTheDocument();
    expect(screen.queryByTestId("evals-tab")).not.toBeInTheDocument();
  });

  it("redirects conformance to home when the feature flag is disabled", async () => {
    clearHostedOAuthPendingState();
    clearScenarioSession();
    window.history.replaceState({}, "", "/conformance");
    mockHandleOAuthCallback.mockReset();

    mockUseFeatureFlagEnabled.mockImplementation(() => false);

    render(<App />);

    await waitFor(() => {
      expect(window.location.pathname).toBe("/home");
    });
  });

  it("keeps host template deep links in place while auth is loading", async () => {
    clearHostedOAuthPendingState();
    clearScenarioSession();
    window.history.replaceState({}, "", "/hosts?template=slack");
    mockHandleOAuthCallback.mockReset();
    mockConvexAuthState.isAuthenticated = false;
    mockConvexAuthState.isLoading = true;

    render(<App />);

    await act(async () => {
      await Promise.resolve();
    });

    expect(window.location.pathname).toBe("/hosts");
    expect(window.location.search).toBe("?template=slack");
    expect(screen.queryByTestId("home-tab")).not.toBeInTheDocument();
  });

  it("syncs direct host URLs into the global previewed host selection", async () => {
    clearHostedOAuthPendingState();
    clearScenarioSession();
    mockUseAppState.mockImplementation(() => ({
      ...createAppStateMock(),
      activeProjectId: "project_local",
      projects: {
        project_local: {
          id: "project_local",
          name: "Project",
          servers: {},
          sharedProjectId: "project_shared",
        },
      },
    }));
    // Convex-shaped ids on purpose: only a real document id is synced and
    // persisted now, so that a catalog slug in the URL (`/hosts/chatgpt`)
    // can't be stored as this project's previewed host — see
    // `HostsRoute.non-id-url.test.tsx`.
    //
    // The route only PERSISTS a host id the project's list confirms, so the
    // list has to actually contain it — the suite default leaves every query
    // but `getCurrentUser` unresolved, which reads as "still loading" and is
    // not the state a real direct-URL visit lands in.
    mockUseQuery.mockImplementation((ref: string) =>
      ref === "users:getCurrentUser"
        ? existingConvexUser
        : ref === "hosts:listHosts"
          ? [
              {
                hostId: "m17b6q9xw2tv4kz8p3r5s0dc",
                name: "Slack",
                hostConfigId: "host-config-slack",
                modelId: "claude-sonnet-4",
                serverCount: 0,
                createdAt: 0,
                updatedAt: 0,
              },
            ]
          : undefined,
    );
    localStorage.setItem(
      "mcp-previewed-host-id",
      JSON.stringify({ project_shared: "kd7n2m5xq9b3tv6yz1r4s0hc" }),
    );
    window.history.replaceState({}, "", "/hosts/m17b6q9xw2tv4kz8p3r5s0dc");

    render(<App />);

    await waitFor(() => {
      expect(
        JSON.parse(localStorage.getItem("mcp-previewed-host-id") ?? "{}"),
      ).toEqual({
        project_shared: "m17b6q9xw2tv4kz8p3r5s0dc",
      });
    });
    expect(screen.getByTestId("hosts-tab")).toBeInTheDocument();
  });

  it("redirects xaa-flow to home when the xaa flag is disabled", async () => {
    clearHostedOAuthPendingState();
    clearScenarioSession();
    window.history.replaceState({}, "", "/xaa-flow");
    mockHandleOAuthCallback.mockReset();

    render(<App />);

    await waitFor(() => {
      expect(screen.getByTestId("home-tab")).toBeInTheDocument();
    });

    expect(window.location.pathname).toBe("/home");
    expect(screen.queryByTestId("xaa-flow-tab")).not.toBeInTheDocument();
  });

  it("renders xaa-flow when the xaa flag is enabled", async () => {
    clearHostedOAuthPendingState();
    clearScenarioSession();
    window.history.replaceState({}, "", "/xaa-flow");
    mockHandleOAuthCallback.mockReset();
    mockUseFeatureFlagEnabled.mockImplementation((flag: string) =>
      flag === "xaa" ? true : false,
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
    clearScenarioSession();
    window.history.replaceState({}, "", "/xaa-flow");
    mockHandleOAuthCallback.mockReset();
    mockUseFeatureFlagEnabled.mockImplementation((flag: string) =>
      flag === "xaa" ? true : false,
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
            autoSelectFilteredServer: "when-empty",
          }),
        }),
      );
    });

    const latestProps = mockHeader.mock.calls.at(-1)?.[0] as {
      activeServerSelectorProps?: { serverConfigs?: unknown };
    };
    expect(latestProps.activeServerSelectorProps?.serverConfigs).toBe(
      currentProjectServers,
    );
  });

  it("passes OAuth-only server selector props on the OAuth Debugger tab", async () => {
    clearHostedOAuthPendingState();
    clearScenarioSession();
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
    appStateMock.displayServerConfigs = currentProjectServers;
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
            autoSelectFilteredServer: "when-empty",
          }),
        }),
      );
    });

    const latestProps = mockHeader.mock.calls.at(-1)?.[0] as {
      activeServerSelectorProps?: { serverConfigs?: unknown };
    };
    expect(latestProps.activeServerSelectorProps?.serverConfigs).toBe(
      currentProjectServers,
    );
    expect(
      (mockOAuthFlowTabState.lastProps as { serverConfigs?: unknown })
        .serverConfigs,
    ).toBe(currentProjectServers);
  });

  it("leaves the header server selector unfiltered outside the OAuth Debugger tab", async () => {
    clearHostedOAuthPendingState();
    clearScenarioSession();
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
        }),
      );
    });
  });

  it("applies the evals billing gate to Runs mode", async () => {
    // Runs used to gate on `cicd` because it was its own tab. Both lenses are
    // one tab now, so the tab-keyed gate is `evals` for both.
    clearHostedOAuthPendingState();
    clearScenarioSession();
    window.history.replaceState({}, "", "/evals/runs");
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
      (flag: string) => flag === "billing-entitlements-ui",
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
              gateKey: "evals",
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
      ([name]) => name === "billing:getProjectPremiumness",
    );

    expect(wsPremiumnessCall?.[1]).toEqual({
      organizationId: "org-1",
      projectId: "shared-ws-1",
    });

    await waitFor(() => {
      expect(screen.getByTestId("home-tab")).toBeInTheDocument();
    });

    expect(window.location.pathname).toBe("/home");
    expect(screen.queryByTestId("evals-tab")).not.toBeInTheDocument();
    expect(screen.queryByTestId("ci-evals-tab")).not.toBeInTheDocument();
  });
});
