import { type ReactNode, useLayoutEffect } from "react";
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
  readBillingSignInReturnPath,
  readPersistedCheckoutIntent,
  persistCheckoutIntent,
  writeBillingSignInReturnPath,
} from "../lib/billing-deep-link";
import {
  clearSandboxSession,
  writeSandboxSignInReturnPath,
  writeSandboxSession,
} from "../lib/sandbox-session";

const {
  createAppStateMock,
  mockAppBuilderTabMounts,
  mockConvexAuthState,
  mockHandleOAuthCallback,
  mockHostedShellGateState,
  mockMCPSidebar,
  mockOrganizationsTab,
  mockPosthogCapture,
  mockPosthogState,
  mockSandboxesTab,
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
    clearConvexActiveWorkspaceSelection: vi.fn(),
    clearLocalFallbackWorkspaceSelection: vi.fn(),
    isCloudSyncActive: false,
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
    mockMCPSidebar: vi.fn(() => <div />),
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
    mockUseAuth: vi.fn(),
    mockUseAppState: vi.fn(createAppStateMock),
    mockUseConvexAuth: vi.fn(),
    mockUseFeatureFlagEnabled: vi.fn(),
    mockUseQuery: vi.fn(() => undefined),
    mockSandboxesTab: vi.fn(() => <div>Sandboxes Tab</div>),
    mockWorkOsAuthState: {
      getAccessToken: vi.fn(),
      signIn: vi.fn(),
      user: null as { id: string } | null,
      isLoading: false,
    },
  };
});

vi.mock("convex/react", () => ({
  useConvexAuth: (...args: unknown[]) => mockUseConvexAuth(...args),
  useQuery: mockUseQuery,
  useMutation: () => vi.fn(),
  useAction: () => vi.fn(),
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
  EvalsTab: () => <div data-testid="evals-tab">Evals Tab</div>,
}));
vi.mock("../components/CiEvalsTab", () => ({
  CiEvalsTab: () => <div data-testid="ci-evals-tab">CI Evals Tab</div>,
}));
vi.mock("../components/ViewsTab", () => ({
  ViewsTab: () => <div />,
}));
vi.mock("../components/SandboxesTab", () => ({
  SandboxesTab: (props: unknown) => mockSandboxesTab(props),
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
    mockSandboxesTab.mockReset();
    mockSandboxesTab.mockImplementation(() => <div>Sandboxes Tab</div>);
    mockMCPSidebar.mockReset();
    mockMCPSidebar.mockImplementation(() => <div data-testid="mcp-sidebar" />);
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
    const orgPremiumnessCall = mockUseQuery.mock.calls.find(
      ([name]) => name === "billing:getOrganizationPremiumness",
    );
    const wsPremiumnessCall = mockUseQuery.mock.calls.find(
      ([name]) => name === "billing:getWorkspacePremiumness",
    );

    expect(entitlementsCall?.[1]).toBe("skip");
    expect(orgPremiumnessCall?.[1]).toBe("skip");
    expect(wsPremiumnessCall?.[1]).toBe("skip");
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
    const orgPremiumnessCall = mockUseQuery.mock.calls.find(
      ([name]) => name === "billing:getOrganizationPremiumness",
    );
    const wsPremiumnessCall = mockUseQuery.mock.calls.find(
      ([name]) => name === "billing:getWorkspacePremiumness",
    );

    expect(entitlementsCall?.[1]).toBe("skip");
    expect(orgPremiumnessCall?.[1]).toBe("skip");
    expect(wsPremiumnessCall?.[1]).toBe("skip");
  });

  it("skips workspace billing and clears stale synced selection when the active workspace is missing", async () => {
    const clearConvexActiveWorkspaceSelection = vi.fn();
    mockUseAppState.mockImplementation(() => ({
      ...createAppStateMock(),
      isCloudSyncActive: true,
      activeOrganizationId: "org-1",
      activeWorkspaceId: "ws-missing",
      clearConvexActiveWorkspaceSelection,
    }));
    mockUseQuery.mockImplementation((name: string) => {
      if (name === "users:getCurrentUser") {
        return null;
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
      ([name]) => name === "billing:getWorkspacePremiumness",
    );

    expect(wsPremiumnessCall?.[1]).toBe("skip");
    await waitFor(() => {
      expect(clearConvexActiveWorkspaceSelection).toHaveBeenCalled();
    });
  });

  it("skips workspace billing and clears synced selection when the active workspace org no longer matches the current org", async () => {
    const clearConvexActiveWorkspaceSelection = vi.fn();
    mockUseAppState.mockImplementation(() => ({
      ...createAppStateMock(),
      isCloudSyncActive: true,
      activeOrganizationId: "org-1",
      clearConvexActiveWorkspaceSelection,
      workspaces: {
        ws_local: {
          id: "ws_local",
          name: "Workspace Two",
          sharedWorkspaceId: "shared-ws-2",
          organizationId: "org-2",
          servers: {},
          createdAt: new Date(),
          updatedAt: new Date(),
        },
      },
    }));
    mockUseQuery.mockImplementation((name: string) => {
      if (name === "users:getCurrentUser") {
        return null;
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
      ([name]) => name === "billing:getWorkspacePremiumness",
    );

    expect(wsPremiumnessCall?.[1]).toBe("skip");
    await waitFor(() => {
      expect(clearConvexActiveWorkspaceSelection).toHaveBeenCalled();
    });
  });

  it("passes a billing-safe workspace id to the sandboxes tab", async () => {
    clearHostedOAuthPendingState();
    clearSandboxSession();
    window.history.replaceState({}, "", "/#sandboxes");

    mockUseAppState.mockImplementation(() => ({
      ...createAppStateMock(),
      isCloudSyncActive: false,
      workspaces: {
        ws_local: {
          id: "ws_local",
          name: "Workspace One",
          sharedWorkspaceId: "shared-ws-1",
          organizationId: "org-1",
          servers: {},
          createdAt: new Date(),
          updatedAt: new Date(),
        },
      },
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
      expect(mockSandboxesTab).toHaveBeenCalled();
    });

    const lastCall =
      mockSandboxesTab.mock.calls[mockSandboxesTab.mock.calls.length - 1];
    expect(lastCall?.[0]).toMatchObject({
      workspaceId: null,
      organizationId: "org-1",
      isBillingContextPending: false,
    });
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

  it("passes the valid organization route into app state for workspace actions", async () => {
    clearHostedOAuthPendingState();
    clearSandboxSession();
    window.history.replaceState({}, "", "/#organizations/org-3");
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

  it("disables sidebar workspace creation when the routed org is free and at cap", async () => {
    clearHostedOAuthPendingState();
    clearSandboxSession();
    window.history.replaceState({}, "", "/#organizations/org-3");
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
              gateKey: "maxWorkspaces",
              kind: "limit",
              scope: "organization",
              canAccess: false,
              shouldShowUpsell: true,
              upgradePlan: "starter",
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
      isCreateWorkspaceDisabled: true,
      createWorkspaceDisabledReason:
        "This organization has reached its workspace limit (1). Upgrade to create more workspaces.",
    });
  });

  it("shows billing handoff loading and triggers sign-in for guest billing entry", async () => {
    clearHostedOAuthPendingState();
    clearSandboxSession();
    window.history.replaceState(
      {},
      "",
      "/billing?plan=starter&interval=annual",
    );

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
      plan: "starter",
      interval: "annual",
    });
    expect(readBillingSignInReturnPath()).toBe("/billing");
    expect(mockOrganizationsTab).not.toHaveBeenCalled();
  });

  it("restores the billing callback back into the billing flow when session intent exists", async () => {
    clearHostedOAuthPendingState();
    clearSandboxSession();
    sessionStorage.clear();
    persistCheckoutIntent({ plan: "starter", interval: "annual" });
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
    clearSandboxSession();
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
    clearSandboxSession();
    sessionStorage.clear();
    persistCheckoutIntent({ plan: "starter", interval: "annual" });
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
            ?.plan === "starter" &&
          (props as { checkoutIntent?: { interval?: string } }).checkoutIntent
            ?.interval === "annual",
      ),
    ).toBe(true);
  });

  it("prefers sandbox callback restoration over billing callback restoration", async () => {
    clearHostedOAuthPendingState();
    clearSandboxSession();
    sessionStorage.clear();
    persistCheckoutIntent({ plan: "starter", interval: "annual" });
    writeBillingSignInReturnPath("/billing");
    writeSandboxSignInReturnPath("/sandbox/demo/token-123");
    window.history.replaceState({}, "", "/callback?code=oauth-code");

    const replaceStateSpy = vi.spyOn(window.history, "replaceState");

    render(<App />);

    await waitFor(() => {
      expect(replaceStateSpy).toHaveBeenCalledWith(
        {},
        "",
        "/sandbox/demo/token-123",
      );
    });
  });

  it("keeps billing resume behind the checkout spinner for signed-in users", async () => {
    clearHostedOAuthPendingState();
    clearSandboxSession();
    window.history.replaceState(
      {},
      "",
      "/billing?plan=starter&interval=annual",
    );

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
            ?.plan === "starter" &&
          (props as { checkoutIntent?: { interval?: string } }).checkoutIntent
            ?.interval === "annual",
      ),
    ).toBe(true);
  });

  it("drops the billing overlay when checkout intent is consumed", async () => {
    clearHostedOAuthPendingState();
    clearSandboxSession();
    window.history.replaceState(
      {},
      "",
      "/billing?plan=starter&interval=annual",
    );

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
    clearSandboxSession();
    window.history.replaceState(
      {},
      "",
      "/billing?plan=starter&interval=annual",
    );

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
    clearSandboxSession();
    window.history.replaceState(
      {},
      "",
      "/billing?plan=starter&interval=annual",
    );

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
      expect(screen.getByText("Servers Tab")).toBeInTheDocument();
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

  it("optimistically switches to the first owned org after deleting the current org", async () => {
    clearHostedOAuthPendingState();
    clearSandboxSession();
    window.history.replaceState({}, "", "/#organizations/org-deleted");

    const setActiveOrganizationId = vi.fn();
    const clearConvexActiveWorkspaceSelection = vi.fn();
    const clearLocalFallbackWorkspaceSelection = vi.fn();
    mockUseAppState.mockImplementation(() => ({
      ...createAppStateMock(),
      activeOrganizationId: "org-deleted",
      setActiveOrganizationId,
      clearConvexActiveWorkspaceSelection,
      clearLocalFallbackWorkspaceSelection,
      workspaces: {
        ws_local: {
          id: "ws_local",
          name: "Deleted Workspace",
          sharedWorkspaceId: "shared-ws-deleted",
          organizationId: "org-deleted",
          servers: {},
          createdAt: new Date(),
          updatedAt: new Date(),
        },
      },
    }));
    mockUseQuery.mockImplementation((name: string) => {
      if (name === "users:getCurrentUser") {
        return null;
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

    expect(clearConvexActiveWorkspaceSelection).toHaveBeenCalled();
    expect(clearLocalFallbackWorkspaceSelection).toHaveBeenCalledWith(
      "org-deleted",
      "org-owned",
    );
    expect(window.location.hash).toBe("#servers");
  });

  it("falls back to the first remaining org when no owned org remains after delete", async () => {
    clearHostedOAuthPendingState();
    clearSandboxSession();
    window.history.replaceState({}, "", "/#organizations/org-deleted");

    const setActiveOrganizationId = vi.fn();
    mockUseAppState.mockImplementation(() => ({
      ...createAppStateMock(),
      activeOrganizationId: "org-deleted",
      setActiveOrganizationId,
    }));
    mockUseQuery.mockImplementation((name: string) => {
      if (name === "users:getCurrentUser") {
        return null;
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

    expect(window.location.hash).toBe("#servers");
  });

  it("clears org and synced workspace selection when deleting the last org", async () => {
    clearHostedOAuthPendingState();
    clearSandboxSession();
    window.history.replaceState({}, "", "/#organizations/org-deleted");

    const setActiveOrganizationId = vi.fn();
    const clearConvexActiveWorkspaceSelection = vi.fn();
    const clearLocalFallbackWorkspaceSelection = vi.fn();
    mockUseAppState.mockImplementation(() => ({
      ...createAppStateMock(),
      activeOrganizationId: "org-deleted",
      setActiveOrganizationId,
      clearConvexActiveWorkspaceSelection,
      clearLocalFallbackWorkspaceSelection,
      workspaces: {
        ws_local: {
          id: "ws_local",
          name: "Deleted Workspace",
          sharedWorkspaceId: "shared-ws-deleted",
          organizationId: "org-deleted",
          servers: {},
          createdAt: new Date(),
          updatedAt: new Date(),
        },
      },
    }));
    mockUseQuery.mockImplementation((name: string) => {
      if (name === "users:getCurrentUser") {
        return null;
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

    expect(clearConvexActiveWorkspaceSelection).toHaveBeenCalled();
    expect(clearLocalFallbackWorkspaceSelection).toHaveBeenCalledWith(
      "org-deleted",
      undefined,
    );
    expect(window.location.hash).toBe("#servers");
  });

  it("still renders the sandboxes tab when workspace premiumness denies sandbox creation", async () => {
    clearHostedOAuthPendingState();
    clearSandboxSession();
    window.history.replaceState({}, "", "/#sandboxes");
    mockUseAppState.mockImplementation(() => ({
      ...createAppStateMock(),
      isCloudSyncActive: true,
      workspaces: {
        ws_local: {
          id: "ws_local",
          name: "Workspace One",
          sharedWorkspaceId: "shared-ws-1",
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

      if (name === "billing:getWorkspacePremiumness") {
        return {
          plan: "free",
          enforcementState: "active",
          effectivePlan: "free",
          billingInterval: null,
          source: "free",
          decisionRequired: false,
          gates: [
            {
              gateKey: "sandboxes",
              kind: "feature",
              scope: "organization",
              canAccess: false,
              shouldShowUpsell: true,
              upgradePlan: "starter",
              reason: "feature_not_included",
            },
          ],
        };
      }

      return undefined;
    });

    render(<App />);

    const wsPremiumnessCall = mockUseQuery.mock.calls.find(
      ([name]) => name === "billing:getWorkspacePremiumness",
    );

    expect(wsPremiumnessCall?.[1]).toEqual({
      organizationId: "org-1",
      workspaceId: "shared-ws-1",
    });

    // Sandboxes tab is NOT blocked at tab level — creation is gated inline
    await waitFor(() => {
      expect(screen.getByText("Sandboxes Tab")).toBeInTheDocument();
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
    mockUseFeatureFlagEnabled.mockImplementation(
      (flag: string) => flag === "playground-enabled",
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
    clearSandboxSession();
    window.history.replaceState({}, "", "/#app-builder");
    mockHandleOAuthCallback.mockReset();
    mockUseFeatureFlagEnabled.mockImplementation(
      (flag: string) => flag === "playground-enabled",
    );

    render(<App />);

    await waitFor(() => {
      expect(screen.getByTestId("app-builder-tab")).toBeInTheDocument();
    });

    expect(screen.queryByTestId("mcp-sidebar")).not.toBeInTheDocument();
    expect(screen.queryByTestId("app-header")).not.toBeInTheDocument();

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
      expect(screen.getByTestId("hosted-oauth-loading")).toBeInTheDocument();
    });

    expect(window.location.hash).toBe("#servers");
    expect(screen.queryByTestId("app-builder-tab")).not.toBeInTheDocument();
    expect(screen.queryByText("Servers Tab")).not.toBeInTheDocument();
  });

  it("does not auto-route signed-in users into App Builder once startup is ready", async () => {
    clearHostedOAuthPendingState();
    clearSandboxSession();
    window.history.replaceState({}, "", "/#servers");
    mockHandleOAuthCallback.mockReset();

    render(<App />);

    await waitFor(() => {
      expect(screen.getByText("Servers Tab")).toBeInTheDocument();
    });

    expect(window.location.hash).toBe("#servers");
    expect(screen.queryByTestId("app-builder-tab")).not.toBeInTheDocument();
  });

  it("keeps Playground available when evaluate-runs is disabled", async () => {
    clearHostedOAuthPendingState();
    clearSandboxSession();
    window.history.replaceState({}, "", "/#/evals");
    mockHandleOAuthCallback.mockReset();
    mockUseFeatureFlagEnabled.mockImplementation(
      (flag: string) => flag === "playground-enabled",
    );

    render(<App />);

    await waitFor(() => {
      expect(screen.getByTestId("evals-tab")).toBeInTheDocument();
    });

    expect(window.location.hash).toBe("#/evals");
    expect(screen.queryByTestId("ci-evals-tab")).not.toBeInTheDocument();
  });

  it("waits on ci-evals while the evaluate-runs flag is still loading", async () => {
    clearHostedOAuthPendingState();
    clearSandboxSession();
    window.history.replaceState({}, "", "/#/ci-evals");
    mockHandleOAuthCallback.mockReset();

    const evaluateRunsState: { value: boolean | undefined } = {
      value: undefined,
    };
    mockPosthogState.featureFlags.hasLoadedFlags = false;
    mockUseFeatureFlagEnabled.mockImplementation((flag: string) =>
      flag === "evaluate-runs"
        ? evaluateRunsState.value
        : flag === "playground-enabled",
    );

    render(<App />);

    expect(window.location.hash).toBe("#/ci-evals");
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

    expect(window.location.hash).toBe("#/ci-evals");
    expect(screen.queryByText("Loading Runs...")).not.toBeInTheDocument();
  });

  it("redirects ci-evals to Playground when evaluate-runs is disabled", async () => {
    clearHostedOAuthPendingState();
    clearSandboxSession();
    window.history.replaceState({}, "", "/#/ci-evals");
    mockHandleOAuthCallback.mockReset();

    mockPosthogState.featureFlags.hasLoadedFlags = false;
    mockUseFeatureFlagEnabled.mockImplementation((flag: string) =>
      flag === "evaluate-runs" ? undefined : flag === "playground-enabled",
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

    expect(window.location.hash).toBe("#/evals");
    expect(screen.queryByTestId("ci-evals-tab")).not.toBeInTheDocument();
  });

  it("redirects nested ci-evals routes to Playground when evaluate-runs is disabled", async () => {
    clearHostedOAuthPendingState();
    clearSandboxSession();
    window.history.replaceState({}, "", "/#/ci-evals/suite/s_123?view=runs");
    mockHandleOAuthCallback.mockReset();

    mockUseFeatureFlagEnabled.mockImplementation((flag: string) =>
      flag === "evaluate-runs" ? undefined : flag === "playground-enabled",
    );

    render(<App />);

    await waitFor(() => {
      expect(screen.getByTestId("evals-tab")).toBeInTheDocument();
    });

    expect(window.location.hash).toBe("#/evals");
    expect(screen.queryByTestId("ci-evals-tab")).not.toBeInTheDocument();
  });

  it("still applies the CI billing redirect when evaluate-runs is enabled", async () => {
    clearHostedOAuthPendingState();
    clearSandboxSession();
    window.history.replaceState({}, "", "/#/ci-evals");
    mockHandleOAuthCallback.mockReset();
    mockUseAppState.mockImplementation(() => ({
      ...createAppStateMock(),
      isCloudSyncActive: true,
      workspaces: {
        ws_local: {
          id: "ws_local",
          name: "Workspace One",
          sharedWorkspaceId: "shared-ws-1",
          organizationId: "org-1",
          servers: {},
          createdAt: new Date(),
          updatedAt: new Date(),
        },
      },
    }));
    mockUseFeatureFlagEnabled.mockImplementation(
      (flag: string) =>
        flag === "billing-entitlements-ui" || flag === "evaluate-runs",
    );
    mockUseQuery.mockImplementation((name: string) => {
      if (name === "users:getCurrentUser") {
        return null;
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

      if (name === "billing:getWorkspacePremiumness") {
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
              upgradePlan: "starter",
              reason: "feature_not_included",
            },
          ],
        };
      }

      return undefined;
    });

    render(<App />);

    const wsPremiumnessCall = mockUseQuery.mock.calls.find(
      ([name]) => name === "billing:getWorkspacePremiumness",
    );

    expect(wsPremiumnessCall?.[1]).toEqual({
      organizationId: "org-1",
      workspaceId: "shared-ws-1",
    });

    await waitFor(() => {
      expect(screen.getByText("Servers Tab")).toBeInTheDocument();
    });

    expect(window.location.hash).toBe("#servers");
    expect(screen.queryByTestId("evals-tab")).not.toBeInTheDocument();
  });

  it("still auto-routes a true hosted guest into App Builder onboarding once startup is ready when Playground is enabled", async () => {
    clearHostedOAuthPendingState();
    clearSandboxSession();
    window.history.replaceState({}, "", "/#servers");
    mockHandleOAuthCallback.mockReset();
    mockConvexAuthState.isAuthenticated = false;
    mockUseFeatureFlagEnabled.mockImplementation(
      (flag: string) => flag === "playground-enabled",
    );

    render(<App />);

    await waitFor(() => {
      expect(screen.getByTestId("app-builder-tab")).toBeInTheDocument();
    });

    expect(window.location.hash).toBe("#app-builder");
  });

  it("still auto-routes a true hosted guest into App Builder onboarding when Playground is disabled", async () => {
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
    expect(screen.queryByText("Servers Tab")).not.toBeInTheDocument();
  });

  it("goes from hosted loading straight to App Builder onboarding for a true guest when Playground is enabled", async () => {
    clearHostedOAuthPendingState();
    clearSandboxSession();
    window.history.replaceState({}, "", "/#servers");
    mockHandleOAuthCallback.mockReset();
    mockConvexAuthState.isAuthenticated = false;
    mockHostedShellGateState.value = "auth-loading";
    mockUseFeatureFlagEnabled.mockImplementation(
      (flag: string) => flag === "playground-enabled",
    );

    const { rerender } = render(<App />);

    await waitFor(() => {
      expect(screen.getByTestId("hosted-oauth-loading")).toBeInTheDocument();
    });

    expect(screen.queryByText("Servers Tab")).not.toBeInTheDocument();
    expect(screen.queryByTestId("app-builder-tab")).not.toBeInTheDocument();

    mockHostedShellGateState.value = "ready";
    rerender(<App />);

    expect(screen.queryByText("Servers Tab")).not.toBeInTheDocument();

    await waitFor(() => {
      expect(screen.getByTestId("app-builder-tab")).toBeInTheDocument();
    });

    expect(window.location.hash).toBe("#app-builder");
    expect(screen.queryByText("Servers Tab")).not.toBeInTheDocument();
  });
});
