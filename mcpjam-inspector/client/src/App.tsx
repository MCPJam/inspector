import { useConvexAuth } from "convex/react";
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type ComponentProps,
} from "react";
import { useAuth } from "@workos-inc/authkit-react";
import { AlertTriangle, Construction, Loader2 } from "lucide-react";
import { toast } from "sonner";
import { ServersTab } from "./components/ServersTab";
import { ToolsTab } from "./components/ToolsTab";
import { ResourcesTab } from "./components/ResourcesTab";
import { PromptsTab } from "./components/PromptsTab";
import { SkillsTab } from "./components/SkillsTab";
import { LearningTab } from "./components/LearningTab";
import { TasksTab } from "./components/TasksTab";
import { ChatTabV2 } from "./components/ChatTabV2";
import type { EvalChatHandoff } from "./lib/eval-chat-handoff";
import { EvalsTab } from "./components/EvalsTab";
import { CiEvalsTab } from "./components/CiEvalsTab";
import { ViewsTab } from "./components/ViewsTab";
import { SandboxesTab } from "./components/SandboxesTab";
import { SettingsTab } from "./components/SettingsTab";
import { WorkspaceSettingsTab } from "./components/WorkspaceSettingsTab";
import { ClientConfigTab } from "./components/client-config/ClientConfigTab";
import { WorkspaceClientConfigSync } from "./components/client-config/WorkspaceClientConfigSync";
import { TracingTab } from "./components/TracingTab";
import { AuthTab } from "./components/AuthTab";
import { OAuthFlowTab } from "./components/OAuthFlowTab";
import { ErrorBoundary } from "./components/evals/ErrorBoundary";
import { AppBuilderTab } from "./components/ui-playground/AppBuilderTab";
import { EmptyState } from "./components/ui/empty-state";
import { isFirstRunEligible } from "./lib/onboarding-state";
import { ProfileTab } from "./components/ProfileTab";
import { BillingUpsellGate } from "./components/billing/BillingUpsellGate";
import { OrganizationsTab } from "./components/OrganizationsTab";
import { SupportTab } from "./components/SupportTab";
import { RegistryTab } from "./components/RegistryTab";
import OAuthDebugCallback from "./components/oauth/OAuthDebugCallback";
import { MCPSidebar } from "./components/mcp-sidebar";
import { SidebarInset, SidebarProvider } from "./components/ui/sidebar";
import { Alert, AlertDescription, AlertTitle } from "./components/ui/alert";
import { Button } from "./components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "./components/ui/dialog";
import { useAppState } from "./hooks/use-app-state";
import { PreferencesStoreProvider } from "./stores/preferences/preferences-provider";
import { Toaster } from "./components/ui/sonner";
import { useElectronOAuth } from "./hooks/useElectronOAuth";
import { useEnsureDbUser } from "./hooks/useEnsureDbUser";
import { usePostHog, useFeatureFlagEnabled } from "posthog-js/react";
import { usePostHogIdentify } from "./hooks/usePostHogIdentify";
import { AppStateProvider } from "./state/app-state-context";
import { useOrganizationQueries } from "./hooks/useOrganizations";
import { useOrganizationBilling } from "./hooks/useOrganizationBilling";
import type { BillingFeatureName } from "./hooks/useOrganizationBilling";

// Import global styles
import "./index.css";
import { detectEnvironment, detectPlatform } from "./lib/PosthogUtils";
import {
  getInitialThemeMode,
  updateThemeMode,
  getInitialThemePreset,
  updateThemePreset,
} from "./lib/theme-utils";
import CompletingSignInLoading from "./components/CompletingSignInLoading";
import LoadingScreen from "./components/LoadingScreen";
import { Header } from "./components/Header";
import { ThemePreset } from "./types/preferences/theme";
import type {
  ActiveServerSelectorProps,
  PlaygroundServerSelectorProps,
} from "./components/ActiveServerSelector";
import { useViewQueries, useWorkspaceServers } from "./hooks/useViews";
import { HostedShellGate } from "./components/hosted/HostedShellGate";
import { resolveHostedShellGateState } from "./components/hosted/hosted-shell-gate-state";
import {
  SharedServerChatPage,
  getSharedPathTokenFromLocation,
} from "./components/hosted/SharedServerChatPage";
import {
  SandboxChatPage,
  getSandboxPathTokenFromLocation,
} from "./components/hosted/SandboxChatPage";
import { useHostedApiContext } from "./hooks/hosted/use-hosted-api-context";
import { HOSTED_MODE } from "./lib/config";
import {
  clearBillingSignInReturnPath,
  clearCheckoutIntentFromUrl,
  clearPersistedCheckoutIntent,
  hasInvalidCheckoutIntervalParam,
  hasInvalidCheckoutQueryParams,
  hashMatchesOrganizationBilling,
  isBillingEntryPathname,
  persistCheckoutIntent,
  type CheckoutIntent,
  readBillingSignInReturnPath,
  readCheckoutIntentFromSearch,
  readPersistedCheckoutIntent,
  resolveCheckoutOrganizationId,
  type CheckoutIntentWithOrganization,
  writeBillingSignInReturnPath,
} from "./lib/billing-deep-link";
import {
  getInvalidOrganizationRouteNavigationTarget,
  getWorkspaceSwitchNavigationTarget,
  resolveHostedNavigation,
  type OrganizationRouteSection,
} from "./lib/hosted-navigation";
import { buildOAuthTokensByServerId } from "./lib/oauth/oauth-tokens";
import {
  formatBillingFeatureName,
  formatPlanName,
  getPremiumnessGateForTab,
  getRequiredBillingFeatureForTab,
  getUpgradePlanForDeniedGate,
  isBillingEnforcementActive,
  isGateAccessDenied,
  isPremiumnessGateDeniedForShell,
} from "./lib/billing-entitlements";
import { BILLING_GATES, resolveBillingGateState } from "./lib/billing-gates";
import { getNewlyConnectedServers } from "./lib/connected-server-auto-open";
import {
  clearHostedOAuthPendingState,
  getHostedOAuthCallbackContext,
  resolveHostedOAuthReturnHash,
} from "./lib/hosted-oauth-callback";
import {
  clearSandboxSignInReturnPath,
  readSandboxSession,
  readSandboxSignInReturnPath,
  writeSandboxSignInReturnPath,
} from "./lib/sandbox-session";
import {
  clearSharedSignInReturnPath,
  readSharedServerSession,
  readSharedSignInReturnPath,
  slugify,
  writeSharedSignInReturnPath,
  readPendingServerAdd,
  clearPendingServerAdd,
} from "./lib/shared-server-session";
import {
  sanitizeHostedOAuthErrorMessage,
  writeHostedOAuthResumeMarker,
} from "./lib/hosted-oauth-resume";
import { handleOAuthCallback } from "./lib/oauth/mcp-oauth";
import { getEffectiveWorkspaceClientCapabilities } from "./lib/client-config";
import { buildEvalsHash } from "./lib/evals-router";
import { withTestingSurface } from "./lib/testing-surface";
import { useClientConfigStore } from "./stores/client-config-store";

function getHostedOAuthCallbackErrorMessage(): string {
  const params = new URLSearchParams(window.location.search);
  const error = params.get("error");
  const description = params.get("error_description");

  if (error === "access_denied" && !description) {
    return "Authorization was cancelled. Try again.";
  }

  return sanitizeHostedOAuthErrorMessage(
    description || error,
    "Authorization could not be completed. Try again.",
  );
}

function replaceHash(hash: string) {
  window.history.replaceState({}, "", `/${hash}`);
  window.dispatchEvent(new HashChangeEvent("hashchange"));
}

function BillingHandoffLoading({ overlay = false }: { overlay?: boolean }) {
  return (
    <div
      className={
        overlay
          ? "fixed inset-0 z-[100] flex items-center justify-center bg-background"
          : "min-h-screen bg-background flex items-center justify-center"
      }
      data-testid={
        overlay ? "billing-handoff-overlay" : "billing-handoff-loading"
      }
    >
      <div className="text-center">
        <Loader2 className="mx-auto size-12 animate-spin text-muted-foreground" />
        <p className="mt-4 text-muted-foreground">Preparing checkout...</p>
      </div>
    </div>
  );
}

function getInitialPendingCheckoutIntent(): CheckoutIntent | null {
  if (typeof window === "undefined") {
    return null;
  }

  if (isBillingEntryPathname(window.location.pathname)) {
    const search = window.location.search;
    const invalid =
      hasInvalidCheckoutQueryParams(search) ||
      hasInvalidCheckoutIntervalParam(search);
    if (invalid) {
      return null;
    }

    const fromUrl = readCheckoutIntentFromSearch(search);
    if (fromUrl) {
      return fromUrl;
    }
  }

  return readPersistedCheckoutIntent();
}

type AppChromeSidebarProps = ComponentProps<typeof MCPSidebar> & {
  hidden: boolean;
};

function AppChromeSidebar({ hidden, ...props }: AppChromeSidebarProps) {
  if (hidden) {
    return null;
  }

  return <MCPSidebar {...props} />;
}

type AppChromeHeaderProps = ComponentProps<typeof Header> & {
  hidden: boolean;
};

function AppChromeHeader({ hidden, ...props }: AppChromeHeaderProps) {
  if (hidden) {
    return null;
  }

  return <Header {...props} />;
}

export default function App() {
  const [activeTab, setActiveTab] = useState("servers");
  const [evalChatHandoff, setEvalChatHandoff] =
    useState<EvalChatHandoff | null>(null);
  const [activeOrganizationSection, setActiveOrganizationSection] =
    useState<OrganizationRouteSection>("overview");
  const [chatHasMessages, setChatHasMessages] = useState(false);
  const [appBuilderOnboarding, setAppBuilderOnboarding] = useState(false);
  const [callbackCompleted, setCallbackCompleted] = useState(false);
  const [callbackRecoveryExpired, setCallbackRecoveryExpired] = useState(false);
  const billingDeepLinkNavRef = useRef(false);
  /** True after we read valid plan/interval from the URL and stripped query params; avoids clearing session on the next /billing tick. */
  const billingCheckoutQueryConsumedRef = useRef(false);
  const [pendingCheckoutIntent, setPendingCheckoutIntent] =
    useState<CheckoutIntent | null>(() => getInitialPendingCheckoutIntent());
  const [billingPathSync, setBillingPathSync] = useState(0);
  const posthog = usePostHog();
  const [evaluateRunsFlagsLoaded, setEvaluateRunsFlagsLoaded] = useState(
    () => posthog.featureFlags?.hasLoadedFlags === true,
  );
  const billingEntitlementsUiEnabled = useFeatureFlagEnabled(
    "billing-entitlements-ui",
  );
  const learningEnabled = useFeatureFlagEnabled("mcpjam-learning");
  const clientConfigEnabled = useFeatureFlagEnabled("client-config-enabled");
  const registryEnabled = useFeatureFlagEnabled("registry-enabled");
  const playgroundEnabled = useFeatureFlagEnabled("playground-enabled");
  const evaluateRunsEnabled = useFeatureFlagEnabled("evaluate-runs");
  const traceViewsEnabled = useFeatureFlagEnabled("trace-views") === true;
  const {
    getAccessToken,
    signIn,
    user: workOsUser,
    isLoading: isWorkOsLoading,
  } = useAuth();
  const { isAuthenticated, isLoading: isAuthLoading } = useConvexAuth();
  const [hostedOAuthHandling, setHostedOAuthHandling] = useState(() =>
    HOSTED_MODE ? getHostedOAuthCallbackContext() !== null : false,
  );
  const [exitedSharedChat, setExitedSharedChat] = useState(false);
  const [exitedSandboxChat, setExitedSandboxChat] = useState(false);
  const sharedPathToken = HOSTED_MODE ? getSharedPathTokenFromLocation() : null;
  const sandboxPathToken = HOSTED_MODE
    ? getSandboxPathTokenFromLocation()
    : null;
  const sharedSession = HOSTED_MODE ? readSharedServerSession() : null;
  const sandboxSession = HOSTED_MODE ? readSandboxSession() : null;
  const currentHashSlug = window.location.hash
    .replace(/^#/, "")
    .replace(/^\/+/, "")
    .split("/")[0];
  const hostedRouteKind = useMemo(() => {
    if (!HOSTED_MODE) {
      return null;
    }

    if (sharedPathToken) {
      return "shared" as const;
    }
    if (sandboxPathToken) {
      return "sandbox" as const;
    }

    if (sharedSession && sandboxSession) {
      if (currentHashSlug === slugify(sharedSession.payload.serverName)) {
        return "shared" as const;
      }
      if (currentHashSlug === slugify(sandboxSession.payload.name)) {
        return "sandbox" as const;
      }
      return null;
    }

    if (sharedSession) {
      return "shared" as const;
    }
    if (sandboxSession) {
      return "sandbox" as const;
    }

    return null;
  }, [
    currentHashSlug,
    sandboxPathToken,
    sandboxSession,
    sharedPathToken,
    sharedSession,
  ]);
  const isSharedChatRoute =
    HOSTED_MODE && !exitedSharedChat && hostedRouteKind === "shared";
  const isSandboxChatRoute =
    HOSTED_MODE && !exitedSandboxChat && hostedRouteKind === "sandbox";

  useEffect(() => {
    setEvaluateRunsFlagsLoaded(posthog.featureFlags?.hasLoadedFlags === true);

    return posthog.onFeatureFlags(() => {
      setEvaluateRunsFlagsLoaded(posthog.featureFlags?.hasLoadedFlags === true);
    });
  }, [posthog]);
  const isHostedChatRoute = isSharedChatRoute || isSandboxChatRoute;
  const currentHash = window.location.hash || "#servers";
  const currentHashRoute = useMemo(
    () => resolveHostedNavigation(currentHash, HOSTED_MODE),
    [currentHash],
  );
  const { sortedOrganizations, isLoading: isLoadingOrganizations } =
    useOrganizationQueries({ isAuthenticated });
  const hasRouteOrganization = !!currentHashRoute.organizationId
    ? sortedOrganizations.some(
        (org) => org._id === currentHashRoute.organizationId,
      )
    : false;

  // Handle hosted OAuth callback: claim the callback before any hosted page renders.
  useEffect(() => {
    const callbackContext = getHostedOAuthCallbackContext();
    if (!callbackContext) return;

    const urlParams = new URLSearchParams(window.location.search);
    const code = urlParams.get("code");
    const error = urlParams.get("error");

    let cancelled = false;
    setHostedOAuthHandling(true);

    const finalizeHostedOAuth = (errorMessage?: string | null) => {
      if (cancelled) return;
      if (callbackContext.serverName) {
        writeHostedOAuthResumeMarker({
          surface: callbackContext.surface,
          serverName: callbackContext.serverName,
          serverUrl: callbackContext.serverUrl,
          errorMessage:
            errorMessage && errorMessage.trim() ? errorMessage : null,
        });
      }

      clearHostedOAuthPendingState();
      localStorage.removeItem("mcp-oauth-pending");
      localStorage.removeItem("mcp-oauth-return-hash");
      const returnHash = resolveHostedOAuthReturnHash(callbackContext);
      window.history.replaceState({}, "", `/${returnHash}`);
      window.dispatchEvent(new Event("hashchange"));
    };

    if (error || !code) {
      finalizeHostedOAuth(getHostedOAuthCallbackErrorMessage());
      setHostedOAuthHandling(false);
      return;
    }

    handleOAuthCallback(code)
      .then((result) => {
        if (result.success) {
          finalizeHostedOAuth(null);
          return;
        }

        finalizeHostedOAuth(
          sanitizeHostedOAuthErrorMessage(
            result.error,
            "Authorization could not be completed. Try again.",
          ),
        );
      })
      .catch((callbackError) => {
        finalizeHostedOAuth(
          sanitizeHostedOAuthErrorMessage(
            callbackError,
            "Authorization could not be completed. Try again.",
          ),
        );
      })
      .finally(() => {
        if (!cancelled) setHostedOAuthHandling(false);
      });

    return () => {
      cancelled = true;
    };
  }, []);

  usePostHogIdentify();

  useEffect(() => {
    if (isAuthLoading) return;
    posthog.capture("app_launched", {
      platform: detectPlatform(),
      environment: detectEnvironment(),
      user_agent: navigator.userAgent,
      version: __APP_VERSION__,
      is_authenticated: isAuthenticated,
    });
  }, [isAuthLoading, isAuthenticated]);

  // Set the initial theme mode and preset on page load
  const initialThemeMode = getInitialThemeMode();
  const initialThemePreset: ThemePreset = getInitialThemePreset();
  useEffect(() => {
    updateThemeMode(initialThemeMode);
    updateThemePreset(initialThemePreset);
  }, []);

  // Set up Electron OAuth callback handling
  useElectronOAuth();
  // Ensure a `users` row exists after Convex auth
  useEnsureDbUser();

  const isDebugCallback = window.location.pathname.startsWith(
    "/oauth/callback/debug",
  );
  const isOAuthCallback = window.location.pathname === "/callback";

  useEffect(() => {
    if (!isOAuthCallback) {
      setCallbackCompleted(false);
      setCallbackRecoveryExpired(false);
      return;
    }

    // Let AuthKit + Convex auth settle before leaving /callback.
    if (!isAuthLoading && isAuthenticated) {
      const sandboxReturnPath = readSandboxSignInReturnPath();
      const sharedReturnPath = readSharedSignInReturnPath();
      const persistedCheckoutIntent = readPersistedCheckoutIntent();
      const billingReturnPath = persistedCheckoutIntent
        ? readBillingSignInReturnPath()
        : null;
      clearSandboxSignInReturnPath();
      clearSharedSignInReturnPath();
      clearBillingSignInReturnPath();
      window.history.replaceState(
        {},
        "",
        sandboxReturnPath ?? sharedReturnPath ?? billingReturnPath ?? "/",
      );
      setCallbackCompleted(true);
      setCallbackRecoveryExpired(false);
      return;
    }

    const timeout = setTimeout(() => {
      setCallbackRecoveryExpired(true);
    }, 15000);

    return () => clearTimeout(timeout);
  }, [isOAuthCallback, isAuthLoading, isAuthenticated]);

  const {
    appState,
    isLoading,
    isLoadingRemoteWorkspaces,
    isWorkspaceBootstrapLoading,
    workspaceServers,
    connectedOrConnectingServerConfigs,
    selectedMCPConfig,
    handleConnect,
    handleDisconnect,
    handleReconnect,
    handleUpdate,
    handleRemoveServer,
    setSelectedServer,
    setSelectedMCPConfigs,
    toggleServerSelection,
    setSelectedMultipleServersToAllServers,
    workspaces,
    activeWorkspaceId,
    handleSwitchWorkspace,
    handleCreateWorkspace,
    handleLeaveWorkspace,
    handleUpdateWorkspace,
    handleUpdateClientConfig,
    handleDeleteWorkspace,
    handleWorkspaceShared,
    saveServerConfigWithoutConnecting,
    handleConnectWithTokensFromOAuthFlow,
    handleRefreshTokensFromOAuthFlow,
    activeOrganizationId,
    setActiveOrganizationId,
  } = useAppState({
    currentUserId: workOsUser?.id ?? null,
    routeOrganizationId: hasRouteOrganization
      ? currentHashRoute.organizationId
      : undefined,
  });
  const activeOrganizationName = sortedOrganizations.find(
    (org) => org._id === activeOrganizationId,
  )?.name;
  const hasAnyWorkspaceServers = Object.keys(workspaceServers).length > 0;
  const hostedShellGateState = resolveHostedShellGateState({
    hostedMode: HOSTED_MODE,
    isConvexAuthLoading: isAuthLoading,
    isConvexAuthenticated: isAuthenticated,
    isWorkOsLoading,
    hasWorkOsUser: !!workOsUser,
    isLoadingRemoteWorkspaces,
  });
  const hostedChatShellGateState = resolveHostedShellGateState({
    hostedMode: HOSTED_MODE,
    isConvexAuthLoading: isAuthLoading,
    isConvexAuthenticated: isAuthenticated,
    isWorkOsLoading,
    hasWorkOsUser: !!workOsUser,
    isLoadingRemoteWorkspaces: false,
  });
  const isOnboardingDecisionReady = hostedShellGateState === "ready";
  const isHostedDefaultRoute = currentHashRoute.normalizedTab === "servers";
  const shouldHoldHostedDefaultRouteForAuth =
    HOSTED_MODE &&
    !isHostedChatRoute &&
    isHostedDefaultRoute &&
    hostedShellGateState === "auth-loading";

  // Auto-add a shared server when returning from SharedServerChatPage via "Open MCPJam"
  useEffect(() => {
    if (isHostedChatRoute) return;
    if (isLoadingRemoteWorkspaces) return;
    if (isAuthLoading) return;

    const pending = readPendingServerAdd();
    if (!pending) return;
    clearPendingServerAdd();

    if (workspaceServers[pending.serverName] !== undefined) {
      return; // Server already exists
    }

    handleConnect({
      name: pending.serverName,
      type: "http",
      url: pending.serverUrl,
      useOAuth: pending.useOAuth,
      clientId: pending.clientId ?? undefined,
      oauthScopes: pending.oauthScopes ?? undefined,
    });
  }, [
    isHostedChatRoute,
    isLoadingRemoteWorkspaces,
    isAuthLoading,
    workspaceServers,
    handleConnect,
  ]);

  const previousConnectedServersRef = useRef<Set<string> | null>(null);
  useEffect(() => {
    const connectedServers = new Set(
      Object.entries(appState.servers)
        .filter(([, server]) => server.connectionStatus === "connected")
        .map(([name]) => name),
    );

    const previousConnectedServers = previousConnectedServersRef.current;
    const newlyConnectedServers = getNewlyConnectedServers(
      previousConnectedServers,
      connectedServers,
    );

    if (activeTab === "servers") {
      const firstVisitServer = newlyConnectedServers.find((serverName) => {
        try {
          return (
            localStorage.getItem(`testing-auto-opened:${serverName}`) !== "true"
          );
        } catch {
          return true;
        }
      });

      if (firstVisitServer) {
        try {
          localStorage.setItem(
            `testing-auto-opened:${firstVisitServer}`,
            "true",
          );
        } catch {
          // Ignore localStorage failures and still select the server.
        }
        setSelectedServer(firstVisitServer);
      }
    }

    previousConnectedServersRef.current = connectedServers;
  }, [activeTab, appState.servers, setSelectedServer]);

  // Auto-select a connected server when navigating to tabs that need one
  useEffect(() => {
    const needsServer =
      activeTab === "app-builder" ||
      activeTab === "tools" ||
      activeTab === "resources" ||
      activeTab === "prompts" ||
      activeTab === "tasks" ||
      activeTab === "auth" ||
      activeTab === "views";
    if (!needsServer || selectedMCPConfig) return;

    const firstConnected = Object.entries(workspaceServers).find(
      ([, server]) => (server as any).connectionStatus === "connected",
    );
    if (firstConnected) {
      setSelectedServer(firstConnected[0]);
    }
  }, [activeTab, selectedMCPConfig, workspaceServers, setSelectedServer]);

  // Create effective app state that uses the correct workspaces (Convex when authenticated)
  const effectiveAppState = useMemo(
    () => ({
      ...appState,
      workspaces,
      activeWorkspaceId,
    }),
    [appState, workspaces, activeWorkspaceId],
  );

  // Get the Convex workspace ID from the active workspace
  const activeWorkspace = workspaces[activeWorkspaceId];
  const isClientConfigSyncPending = useClientConfigStore(
    (state) =>
      state.isAwaitingRemoteEcho &&
      state.pendingWorkspaceId === activeWorkspaceId,
  );
  const hostedClientCapabilities = getEffectiveWorkspaceClientCapabilities(
    activeWorkspace?.clientConfig,
  ) as Record<string, unknown>;
  const convexWorkspaceId = activeWorkspace?.sharedWorkspaceId ?? null;
  const routeScopedOrganizationId = hasRouteOrganization
    ? (currentHashRoute.organizationId ?? null)
    : null;
  const rawBillingOrganizationId =
    routeScopedOrganizationId ??
    activeOrganizationId ??
    activeWorkspace?.organizationId ??
    null;
  const billingOrganizationId =
    !isLoadingOrganizations &&
    rawBillingOrganizationId &&
    sortedOrganizations.some((org) => org._id === rawBillingOrganizationId)
      ? rawBillingOrganizationId
      : null;
  const {
    billingStatus: shellBillingStatus,
    organizationPremiumness,
    workspacePremiumness,
    selectFreeAfterTrial,
    isSelectingFreeAfterTrial,
  } = useOrganizationBilling(isAuthenticated ? billingOrganizationId : null, {
    workspaceId: convexWorkspaceId,
  });
  const billingUiEnabled = billingEntitlementsUiEnabled === true;
  const navPremiumness =
    convexWorkspaceId && workspacePremiumness
      ? workspacePremiumness
      : organizationPremiumness;
  const activeTabGate = getPremiumnessGateForTab(activeTab);
  const activeTabBillingLocked = isPremiumnessGateDeniedForShell({
    billingUiEnabled,
    workspacePremiumness,
    organizationPremiumness,
    hasWorkspace: !!convexWorkspaceId,
    gateKey: activeTabGate,
  });
  const activeTabBillingFeature = getRequiredBillingFeatureForTab(activeTab);
  const upgradePlanForActiveTab = getUpgradePlanForDeniedGate(
    navPremiumness,
    activeTabGate,
  );
  const workspaceCreationGate = resolveBillingGateState({
    billingUiEnabled,
    organizationId: billingOrganizationId,
    billingStatus: shellBillingStatus,
    premiumness: organizationPremiumness,
    gate: BILLING_GATES.workspaceCreation,
  });
  const sidebarGateDenied = useMemo(() => {
    const denied: Partial<Record<BillingFeatureName, boolean>> = {};
    for (const key of ["evals", "sandboxes", "cicd"] as const) {
      denied[key] = isGateAccessDenied(navPremiumness, key);
    }
    return denied;
  }, [navPremiumness]);
  const billingGateEnforcementActive =
    billingUiEnabled && isBillingEnforcementActive(navPremiumness);
  const guestWorkspaceLimitReached =
    !isAuthenticated && Object.keys(workspaces).length >= 1;
  const isCreateWorkspaceDisabled =
    workspaceCreationGate.isDenied || guestWorkspaceLimitReached;
  const createWorkspaceDisabledReason = guestWorkspaceLimitReached
    ? "Sign in to create more workspaces"
    : (workspaceCreationGate.denialMessage ?? undefined);
  const [trialModalDismissedForOrg, setTrialModalDismissedForOrg] = useState<
    string | null
  >(null);
  const trialModalDismissed =
    trialModalDismissedForOrg === billingOrganizationId;
  const showTrialDecisionModal =
    billingUiEnabled &&
    shellBillingStatus?.decisionRequired === true &&
    shellBillingStatus?.isOwner === true &&
    !trialModalDismissed;
  const showTrialDecisionNotice =
    billingUiEnabled &&
    shellBillingStatus?.decisionRequired === true &&
    shellBillingStatus?.isOwner === false;

  // Fetch views for the workspace to determine which servers have saved views
  const { viewsByServer } = useViewQueries({
    isAuthenticated,
    workspaceId: convexWorkspaceId,
  });

  // Fetch workspace servers to map server IDs to names
  const { serversById } = useWorkspaceServers({
    isAuthenticated,
    workspaceId: convexWorkspaceId,
  });
  const hostedServerIdsByName = useMemo(
    () =>
      Object.fromEntries(
        Array.from(serversById.entries()).map(([id, name]) => [name, id]),
      ),
    [serversById],
  );
  const oauthTokensByServerId = useMemo(
    () =>
      buildOAuthTokensByServerId(
        Object.keys(hostedServerIdsByName),
        (name) => hostedServerIdsByName[name],
        (name) => appState.servers[name]?.oauthTokens?.access_token,
      ),
    [hostedServerIdsByName, appState.servers],
  );
  // Extract MCPServerConfig objects for guest mode (keyed by server name)
  const guestServerConfigs = useMemo(
    () =>
      Object.fromEntries(
        Object.entries(appState.servers).map(([name, s]) => [name, s.config]),
      ),
    [appState.servers],
  );
  const guestOauthTokensByServerName = useMemo(
    () =>
      Object.fromEntries(
        Object.entries(appState.servers)
          .filter(([, server]) => !!server.oauthTokens?.access_token)
          .map(([name, server]) => [name, server.oauthTokens!.access_token]),
      ),
    [appState.servers],
  );

  useHostedApiContext({
    workspaceId: convexWorkspaceId,
    serverIdsByName: hostedServerIdsByName,
    clientCapabilities: hostedClientCapabilities,
    clientConfigSyncPending: isClientConfigSyncPending,
    getAccessToken,
    oauthTokensByServerId,
    guestOauthTokensByServerName,
    isAuthenticated,
    serverConfigs: guestServerConfigs,
    enabled: !isHostedChatRoute,
  });

  // Compute the set of server names that have saved views
  const serversWithViews = useMemo(() => {
    const serverNames = new Set<string>();
    for (const serverId of viewsByServer.keys()) {
      const serverName = serversById.get(serverId);
      if (serverName) {
        serverNames.add(serverName);
      }
    }
    return serverNames;
  }, [viewsByServer, serversById]);

  const applyNavigation = useCallback(
    (
      target: string,
      options?: { updateHash?: boolean; enforceCanonicalHash?: boolean },
    ) => {
      if (isSharedChatRoute) {
        const storedSession = readSharedServerSession();
        if (storedSession) {
          const expectedHash = slugify(storedSession.payload.serverName);
          if (window.location.hash !== `#${expectedHash}`) {
            window.location.hash = expectedHash;
          }
        }
        return;
      }

      if (isSandboxChatRoute) {
        const storedSession = readSandboxSession();
        if (storedSession) {
          const expectedHash = slugify(storedSession.payload.name);
          if (window.location.hash !== `#${expectedHash}`) {
            window.location.hash = expectedHash;
          }
        }
        return;
      }

      const resolved = resolveHostedNavigation(target, HOSTED_MODE);

      if (
        options?.enforceCanonicalHash &&
        resolved.rawSection !== resolved.normalizedSection
      ) {
        if (window.location.hash !== `#${resolved.normalizedSection}`) {
          window.location.hash = resolved.normalizedSection;
        }
        return;
      }

      if (resolved.isBlocked) {
        toast.error(
          `${resolved.normalizedTab} is not available in hosted mode.`,
        );
        setActiveOrganizationId(undefined);
        setActiveTab("servers");
        setChatHasMessages(false);
        if (window.location.hash !== "#servers") {
          window.location.hash = "servers";
        }
        return;
      }

      if (resolved.organizationId) {
        setActiveOrganizationId(resolved.organizationId);
      }
      if (resolved.organizationSection) {
        setActiveOrganizationSection(resolved.organizationSection);
      } else if (resolved.normalizedTab !== "organizations") {
        setActiveOrganizationSection("overview");
      }
      if (resolved.shouldSelectAllServers) {
        setSelectedMultipleServersToAllServers();
      }
      if (resolved.shouldClearChatMessages) {
        setChatHasMessages(false);
      }
      if (options?.updateHash) {
        window.location.hash = resolved.normalizedSection;
      }
      setActiveTab(resolved.normalizedTab);
    },
    [
      isSandboxChatRoute,
      isSharedChatRoute,
      setSelectedMultipleServersToAllServers,
    ],
  );

  // Sync tab with hash on mount and when hash changes
  useLayoutEffect(() => {
    if (isHostedChatRoute) {
      return;
    }

    const applyHash = () => {
      const currentHash = window.location.hash || "#servers";
      applyNavigation(currentHash, { enforceCanonicalHash: true });
    };
    applyHash();
    window.addEventListener("hashchange", applyHash);
    return () => window.removeEventListener("hashchange", applyHash);
  }, [applyNavigation, isHostedChatRoute]);

  useLayoutEffect(() => {
    if (isHostedChatRoute) {
      return;
    }

    if (!isOnboardingDecisionReady) {
      return;
    }

    if (
      isFirstRunEligible(
        hasAnyWorkspaceServers,
        window.location.hash,
        isAuthenticated,
      )
    ) {
      applyNavigation("app-builder", { updateHash: true });
    }
  }, [
    applyNavigation,
    hasAnyWorkspaceServers,
    isAuthenticated,
    isOnboardingDecisionReady,
    isHostedChatRoute,
  ]);

  const consumeCheckoutIntent = useCallback(() => {
    clearPersistedCheckoutIntent();
    clearBillingSignInReturnPath();
    clearCheckoutIntentFromUrl();
    setPendingCheckoutIntent(null);
    billingDeepLinkNavRef.current = false;
    billingCheckoutQueryConsumedRef.current = false;
  }, []);

  const handleCheckoutIntentNavigationStarted = useCallback(() => {
    consumeCheckoutIntent();
  }, [consumeCheckoutIntent]);

  // `/billing?plan=&interval=` → auth (if needed) → org billing hash → auto-checkout when intent is valid.
  useEffect(() => {
    if (isDebugCallback) return;
    if (isHostedChatRoute) return;

    const path = window.location.pathname;
    if (!isBillingEntryPathname(path)) {
      billingCheckoutQueryConsumedRef.current = false;
    }

    if (window.location.pathname === "/callback") return;

    const onBillingEntry = isBillingEntryPathname(path);

    if (onBillingEntry) {
      billingDeepLinkNavRef.current = false;
      const search = window.location.search;
      const invalid =
        hasInvalidCheckoutQueryParams(search) ||
        hasInvalidCheckoutIntervalParam(search);

      if (invalid) {
        clearPersistedCheckoutIntent();
        clearBillingSignInReturnPath();
        setPendingCheckoutIntent(null);
        billingCheckoutQueryConsumedRef.current = false;
      } else {
        const fromUrl = readCheckoutIntentFromSearch(search);
        if (fromUrl) {
          persistCheckoutIntent(fromUrl);
          setPendingCheckoutIntent(fromUrl);
          billingCheckoutQueryConsumedRef.current = true;
        } else if (!new URLSearchParams(search).has("plan")) {
          const persistedIntent = readPersistedCheckoutIntent();
          if (persistedIntent) {
            billingCheckoutQueryConsumedRef.current = true;
            if (
              pendingCheckoutIntent?.plan !== persistedIntent.plan ||
              pendingCheckoutIntent?.interval !== persistedIntent.interval
            ) {
              setPendingCheckoutIntent(persistedIntent);
            }
          } else if (!billingCheckoutQueryConsumedRef.current) {
            clearPersistedCheckoutIntent();
            clearBillingSignInReturnPath();
            setPendingCheckoutIntent(null);
          }
        }
      }

      clearCheckoutIntentFromUrl();

      if (!isAuthenticated) {
        if (!isAuthLoading) {
          writeBillingSignInReturnPath(path);
          void signIn();
        }
        return;
      }

      if (path !== "/" && path !== "") {
        window.history.replaceState(
          {},
          "",
          `${window.location.origin}/${window.location.hash}`,
        );
        setBillingPathSync((n) => n + 1);
      }
    }

    if (!isAuthenticated || isAuthLoading) return;
    if (isLoadingOrganizations) return;

    if (billingEntitlementsUiEnabled === false) {
      return;
    }

    if (!pendingCheckoutIntent) {
      billingDeepLinkNavRef.current = false;
      return;
    }

    const workspaceOrgId = activeWorkspace?.organizationId;
    const orgId = resolveCheckoutOrganizationId(
      sortedOrganizations,
      activeOrganizationId,
      workspaceOrgId,
    );

    if (!orgId) {
      toast.error("Create or join an organization to continue with checkout.");
      consumeCheckoutIntent();
      return;
    }

    const h = window.location.hash || "";
    if (hashMatchesOrganizationBilling(h, orgId)) {
      return;
    }

    if (billingDeepLinkNavRef.current) {
      return;
    }

    applyNavigation(`organizations/${orgId}/billing`, { updateHash: true });
    billingDeepLinkNavRef.current = true;
  }, [
    activeOrganizationId,
    activeWorkspace?.organizationId,
    applyNavigation,
    billingEntitlementsUiEnabled,
    billingPathSync,
    consumeCheckoutIntent,
    isAuthLoading,
    isAuthenticated,
    isDebugCallback,
    isHostedChatRoute,
    isLoadingOrganizations,
    pendingCheckoutIntent,
    signIn,
    sortedOrganizations,
    workOsUser?.id,
  ]);

  useEffect(() => {
    if (activeTab === "ci-evals") {
      if (!evaluateRunsFlagsLoaded) {
        return;
      }

      if (evaluateRunsEnabled !== true) {
        replaceHash(withTestingSurface(buildEvalsHash({ type: "list" })));
        return;
      }
    }

    if (activeTabBillingLocked && activeTabBillingFeature) {
      toast.error(
        `${formatBillingFeatureName(activeTabBillingFeature)} is not included in the ${formatPlanName(
          shellBillingStatus?.plan,
        )} plan. Upgrade the organization to continue.`,
      );
      applyNavigation("servers", { updateHash: true });
    } else if (activeTab === "registry" && registryEnabled !== true) {
      applyNavigation("servers", { updateHash: true });
    } else if (
      activeTab === "learning" &&
      (learningEnabled !== true || !isAuthenticated)
    ) {
      applyNavigation("servers", { updateHash: true });
    } else if (
      activeTab === "client-config" &&
      (clientConfigEnabled !== true || !isAuthenticated)
    ) {
      applyNavigation("servers", { updateHash: true });
    }
  }, [
    clientConfigEnabled,
    registryEnabled,
    learningEnabled,
    evaluateRunsFlagsLoaded,
    evaluateRunsEnabled,
    isAuthenticated,
    activeTab,
    applyNavigation,
  ]);

  const handleNavigate = (section: string) => {
    applyNavigation(section, { updateHash: true });
  };

  const handleContinueEvalInChat = useCallback(
    (handoff: Omit<EvalChatHandoff, "id">) => {
      setSelectedMCPConfigs(handoff.serverNames);
      setEvalChatHandoff({
        ...handoff,
        id: `eval-chat-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      });
      applyNavigation("chat-v2", { updateHash: true });
    },
    [applyNavigation, setSelectedMCPConfigs],
  );

  useEffect(() => {
    if (!isAuthenticated) {
      return;
    }

    const navigationTarget = getInvalidOrganizationRouteNavigationTarget({
      routeTab: currentHashRoute.normalizedTab,
      routeOrganizationId: currentHashRoute.organizationId,
      isLoadingOrganizations,
      hasRouteOrganization,
    });
    if (!navigationTarget) {
      return;
    }

    setActiveOrganizationId(undefined);
    setActiveOrganizationSection("overview");
    applyNavigation(navigationTarget, { updateHash: true });
  }, [
    applyNavigation,
    currentHashRoute.normalizedTab,
    currentHashRoute.organizationId,
    hasRouteOrganization,
    isAuthenticated,
    isLoadingOrganizations,
    setActiveOrganizationId,
  ]);

  const handleSidebarSwitchWorkspace = useCallback(
    async (workspaceId: string) => {
      const nextWorkspace = workspaces[workspaceId];
      await handleSwitchWorkspace(workspaceId);

      const navigationTarget = getWorkspaceSwitchNavigationTarget({
        activeTab,
        activeOrganizationId,
        nextWorkspaceOrganizationId: nextWorkspace?.organizationId,
      });
      if (navigationTarget) {
        applyNavigation(navigationTarget, { updateHash: true });
      }
    },
    [
      activeOrganizationId,
      activeTab,
      applyNavigation,
      handleSwitchWorkspace,
      workspaces,
    ],
  );

  const isBillingEntryHandoff =
    !isHostedChatRoute &&
    isBillingEntryPathname(window.location.pathname) &&
    pendingCheckoutIntent !== null;
  const checkoutIntentForBilling =
    useMemo((): CheckoutIntentWithOrganization | null => {
      if (
        !billingUiEnabled ||
        activeTab !== "organizations" ||
        !currentHashRoute.organizationId ||
        currentHashRoute.organizationSection !== "billing" ||
        !pendingCheckoutIntent
      ) {
        return null;
      }
      return {
        plan: pendingCheckoutIntent.plan,
        interval: pendingCheckoutIntent.interval,
        organizationId: currentHashRoute.organizationId,
      };
    }, [
      billingUiEnabled,
      activeTab,
      currentHashRoute.organizationId,
      currentHashRoute.organizationSection,
      pendingCheckoutIntent?.interval,
      pendingCheckoutIntent?.plan,
    ]);

  const playgroundServerSelectorProps = useMemo(():
    | PlaygroundServerSelectorProps
    | undefined => {
    if (activeTab !== "app-builder") return undefined;
    return {
      serverConfigs: workspaceServers,
      selectedServer: appState.selectedServer,
      selectedMultipleServers: appState.selectedMultipleServers,
      isMultiSelectEnabled: false,
      onServerChange: setSelectedServer,
      onMultiServerToggle: toggleServerSelection,
      onConnect: handleConnect,
      onReconnect: handleReconnect,
      showOnlyOAuthServers: false,
      showOnlyServersWithViews: false,
    };
  }, [
    activeTab,
    workspaceServers,
    appState.selectedServer,
    appState.selectedMultipleServers,
    setSelectedServer,
    toggleServerSelection,
    handleConnect,
    handleReconnect,
  ]);

  if (isDebugCallback) {
    return <OAuthDebugCallback />;
  }

  if (hostedOAuthHandling) {
    return <LoadingScreen />;
  }

  if (isOAuthCallback && !callbackCompleted) {
    if (callbackRecoveryExpired) {
      return (
        <div
          className="flex min-h-screen flex-col items-center justify-center gap-4 p-6 text-center"
          data-testid="callback-auth-timeout"
        >
          <p className="text-sm text-muted-foreground">
            Sign-in is taking longer than expected.
          </p>
          <div className="flex gap-2">
            <button
              type="button"
              className="rounded bg-primary px-4 py-2 text-sm font-medium text-primary-foreground"
              onClick={() => signIn()}
            >
              Try sign in again
            </button>
            <button
              type="button"
              className="rounded border px-4 py-2 text-sm font-medium"
              onClick={() => window.location.reload()}
            >
              Reload
            </button>
          </div>
        </div>
      );
    }

    return <CompletingSignInLoading />;
  }

  if (isBillingEntryHandoff) {
    return <BillingHandoffLoading />;
  }

  if (isLoading && !isHostedChatRoute) {
    return <LoadingScreen />;
  }

  const shouldShowBillingHandoffOverlay =
    !isHostedChatRoute &&
    !isOAuthCallback &&
    billingEntitlementsUiEnabled !== false &&
    pendingCheckoutIntent !== null;
  const shouldShowWorkspaceBootstrapOverlay =
    !shouldShowBillingHandoffOverlay &&
    !isHostedChatRoute &&
    !isOAuthCallback &&
    isWorkspaceBootstrapLoading;

  if (shouldHoldHostedDefaultRouteForAuth) {
    return <LoadingScreen />;
  }

  const shouldShowActiveServerSelector =
    activeTab === "tools" ||
    activeTab === "resources" ||
    activeTab === "prompts" ||
    activeTab === "tasks" ||
    activeTab === "oauth-flow" ||
    activeTab === "chat" ||
    activeTab === "chat-v2" ||
    activeTab === "evals" ||
    activeTab === "views" ||
    activeTab === "app-builder";

  const activeServerSelectorProps: ActiveServerSelectorProps | undefined =
    shouldShowActiveServerSelector
      ? {
          serverConfigs:
            activeTab === "oauth-flow" ? appState.servers : workspaceServers,
          selectedServer: appState.selectedServer,
          onServerChange: setSelectedServer,
          onConnect: handleConnect,
          onReconnect: handleReconnect,
          isMultiSelectEnabled: activeTab === "chat" || activeTab === "chat-v2",
          onMultiServerToggle: toggleServerSelection,
          selectedMultipleServers: appState.selectedMultipleServers,
          showOnlyOAuthServers: false,
          showOnlyServersWithViews: activeTab === "views",
          serversWithViews: serversWithViews,
          hasMessages: activeTab === "chat-v2" ? chatHasMessages : false,
        }
      : undefined;

  const appContent = (
    <SidebarProvider defaultOpen={true}>
      <AppChromeSidebar
        hidden={appBuilderOnboarding}
        onNavigate={handleNavigate}
        activeTab={activeTab}
        servers={workspaceServers}
        workspaces={workspaces}
        activeWorkspaceId={activeWorkspaceId}
        onSwitchWorkspace={handleSidebarSwitchWorkspace}
        onCreateWorkspace={handleCreateWorkspace}
        onDeleteWorkspace={handleDeleteWorkspace}
        isLoadingWorkspaces={isLoadingRemoteWorkspaces}
        activeOrganizationId={activeOrganizationId}
        billingUiEnabled={billingUiEnabled}
        billingGateDenied={sidebarGateDenied}
        billingGateEnforcementActive={billingGateEnforcementActive}
        isCreateWorkspaceDisabled={isCreateWorkspaceDisabled}
        createWorkspaceDisabledReason={createWorkspaceDisabledReason}
      />
      <SidebarInset className="flex flex-col min-h-0">
        <AppChromeHeader
          hidden={appBuilderOnboarding}
          activeServerSelectorProps={activeServerSelectorProps}
        />
        <div className="flex flex-1 min-h-0 flex-col overflow-hidden h-full">
          {showTrialDecisionNotice ? (
            <div className="border-b border-border/60 px-4 py-3">
              <Alert>
                <AlertTriangle className="h-4 w-4" />
                <AlertTitle>Billing decision required</AlertTitle>
                <AlertDescription>
                  This organization&apos;s trial has ended. An owner must
                  upgrade or choose the free plan to restore full access.
                </AlertDescription>
              </Alert>
            </div>
          ) : null}
          {/* Content Areas */}
          {activeTab === "servers" && (
            <ServersTab
              workspaceServers={workspaceServers}
              onConnect={handleConnect}
              onDisconnect={handleDisconnect}
              onReconnect={handleReconnect}
              onUpdate={handleUpdate}
              onRemove={handleRemoveServer}
              workspaces={workspaces}
              activeWorkspaceId={activeWorkspaceId}
              isLoadingWorkspaces={isLoadingRemoteWorkspaces}
              onWorkspaceShared={handleWorkspaceShared}
              onLeaveWorkspace={() => handleLeaveWorkspace(activeWorkspaceId)}
              isRegistryEnabled={registryEnabled === true}
              onNavigateToRegistry={
                registryEnabled === true
                  ? () => handleNavigate("registry")
                  : undefined
              }
            />
          )}
          {activeTab === "registry" && registryEnabled === true && (
            <RegistryTab
              workspaceId={convexWorkspaceId}
              isAuthenticated={isAuthenticated}
              onConnect={handleConnect}
              onDisconnect={handleDisconnect}
              onNavigate={handleNavigate}
              servers={workspaceServers}
            />
          )}
          {activeTab === "tools" && (
            <div className="h-full overflow-hidden">
              <ToolsTab
                serverConfig={selectedMCPConfig}
                serverName={appState.selectedServer}
              />
            </div>
          )}
          {activeTab === "evals" &&
            (playgroundEnabled === false ? (
              <EmptyState
                icon={Construction}
                title="Playground Coming Soon"
                description="The Playground is under construction. Stay tuned!"
              />
            ) : billingUiEnabled &&
              activeTabBillingLocked &&
              activeTabBillingFeature ? (
              <BillingUpsellGate
                feature={activeTabBillingFeature}
                currentPlan={
                  shellBillingStatus?.effectivePlan ??
                  shellBillingStatus?.plan ??
                  "free"
                }
                upgradePlan={upgradePlanForActiveTab}
                canManageBilling={shellBillingStatus?.canManageBilling ?? false}
                onNavigateToBilling={() => {
                  if (billingOrganizationId) {
                    applyNavigation(
                      `organizations/${billingOrganizationId}/billing`,
                      { updateHash: true },
                    );
                  }
                }}
              />
            ) : (
              <EvalsTab
                selectedServer={appState.selectedServer}
                workspaceId={convexWorkspaceId}
                onContinueInChat={handleContinueEvalInChat}
              />
            ))}
          {activeTab === "ci-evals" &&
            (!evaluateRunsFlagsLoaded ? (
              <div className="flex h-full min-h-[320px] items-center justify-center">
                <div className="text-center">
                  <Loader2 className="mx-auto h-8 w-8 animate-spin text-primary" />
                  <p className="mt-4 text-sm text-muted-foreground">
                    Loading Runs...
                  </p>
                </div>
              </div>
            ) : evaluateRunsEnabled === true ? (
              billingUiEnabled &&
              activeTabBillingLocked &&
              activeTabBillingFeature ? (
                <BillingUpsellGate
                  feature={activeTabBillingFeature}
                  currentPlan={
                    shellBillingStatus?.effectivePlan ??
                    shellBillingStatus?.plan ??
                    "free"
                  }
                  upgradePlan={upgradePlanForActiveTab}
                  canManageBilling={
                    shellBillingStatus?.canManageBilling ?? false
                  }
                  onNavigateToBilling={() => {
                    if (billingOrganizationId) {
                      applyNavigation(
                        `organizations/${billingOrganizationId}/billing`,
                        { updateHash: true },
                      );
                    }
                  }}
                />
              ) : (
                <CiEvalsTab convexWorkspaceId={convexWorkspaceId} />
              )
            ) : null)}
          {activeTab === "views" && (
            <ViewsTab selectedServer={appState.selectedServer} />
          )}
          {activeTab === "sandboxes" &&
            (billingUiEnabled &&
            activeTabBillingLocked &&
            activeTabBillingFeature ? (
              <BillingUpsellGate
                feature={activeTabBillingFeature}
                currentPlan={
                  shellBillingStatus?.effectivePlan ??
                  shellBillingStatus?.plan ??
                  "free"
                }
                upgradePlan={upgradePlanForActiveTab}
                canManageBilling={shellBillingStatus?.canManageBilling ?? false}
                onNavigateToBilling={() => {
                  if (billingOrganizationId) {
                    applyNavigation(
                      `organizations/${billingOrganizationId}/billing`,
                      { updateHash: true },
                    );
                  }
                }}
              />
            ) : (
              <SandboxesTab workspaceId={convexWorkspaceId} />
            ))}
          {activeTab === "resources" && (
            <div className="h-full overflow-hidden">
              <ResourcesTab
                serverConfig={selectedMCPConfig}
                serverName={appState.selectedServer}
              />
            </div>
          )}

          {activeTab === "prompts" && (
            <div className="h-full overflow-hidden">
              <PromptsTab
                serverConfig={selectedMCPConfig}
                serverName={appState.selectedServer}
              />
            </div>
          )}

          {activeTab === "skills" && <SkillsTab />}

          {activeTab === "learning" && <LearningTab />}

          <div
            className={
              activeTab === "tasks" ? "h-full overflow-hidden" : "hidden"
            }
          >
            <TasksTab
              serverConfig={selectedMCPConfig}
              serverName={appState.selectedServer}
              isActive={activeTab === "tasks"}
            />
          </div>

          {activeTab === "auth" && (
            <AuthTab
              serverConfig={selectedMCPConfig}
              serverEntry={appState.servers[appState.selectedServer]}
              serverName={appState.selectedServer}
            />
          )}

          {activeTab === "oauth-flow" && (
            <ErrorBoundary
              fallback={
                <div className="flex items-center justify-center h-full text-muted-foreground">
                  Something went wrong in the OAuth Debugger. Try refreshing the
                  page.
                </div>
              }
            >
              <OAuthFlowTab
                serverConfigs={appState.servers}
                selectedServerName={appState.selectedServer}
                onSelectServer={setSelectedServer}
                onSaveServerConfig={saveServerConfigWithoutConnecting}
                onConnectWithTokens={handleConnectWithTokensFromOAuthFlow}
                onRefreshTokens={handleRefreshTokensFromOAuthFlow}
              />
            </ErrorBoundary>
          )}
          {activeTab === "chat-v2" && (
            <ChatTabV2
              connectedOrConnectingServerConfigs={
                connectedOrConnectingServerConfigs
              }
              selectedServerNames={appState.selectedMultipleServers}
              onHasMessagesChange={setChatHasMessages}
              enableTraceViews={traceViewsEnabled}
              enableMultiModelChat
              evalChatHandoff={evalChatHandoff}
              onEvalChatHandoffConsumed={(id) =>
                setEvalChatHandoff((current) =>
                  current?.id === id ? null : current,
                )
              }
            />
          )}
          {activeTab === "tracing" && <TracingTab />}
          {activeTab === "app-builder" && (
            <AppBuilderTab
              serverConfig={selectedMCPConfig}
              serverName={appState.selectedServer}
              servers={workspaceServers}
              isAuthenticated={isAuthenticated}
              isAuthLoading={isAuthLoading}
              onConnect={handleConnect}
              onOnboardingChange={setAppBuilderOnboarding}
              playgroundServerSelectorProps={playgroundServerSelectorProps}
              enableTraceViews={traceViewsEnabled}
              enableMultiModelChat
            />
          )}
          {activeTab === "client-config" && (
            <ClientConfigTab
              activeWorkspaceId={activeWorkspaceId}
              workspace={activeWorkspace}
              onSaveClientConfig={handleUpdateClientConfig}
            />
          )}
          {activeTab === "workspace-settings" && (
            <WorkspaceSettingsTab
              activeWorkspaceId={activeWorkspaceId}
              workspace={activeWorkspace}
              convexWorkspaceId={convexWorkspaceId}
              workspaceServers={workspaceServers}
              organizationName={activeOrganizationName}
              onUpdateWorkspace={handleUpdateWorkspace}
              onDeleteWorkspace={handleDeleteWorkspace}
              onWorkspaceShared={handleWorkspaceShared}
              onNavigateAway={() => handleNavigate("servers")}
            />
          )}
          {activeTab === "settings" && <SettingsTab />}
          {activeTab === "support" && <SupportTab />}
          {activeTab === "profile" && <ProfileTab />}
          {activeTab === "organizations" && (
            <OrganizationsTab
              organizationId={currentHashRoute.organizationId}
              section={
                currentHashRoute.organizationSection ??
                activeOrganizationSection
              }
              checkoutIntent={checkoutIntentForBilling}
              onCheckoutIntentConsumed={consumeCheckoutIntent}
              onCheckoutIntentNavigationStarted={
                handleCheckoutIntentNavigationStarted
              }
            />
          )}
        </div>
      </SidebarInset>
      <Dialog
        open={showTrialDecisionModal}
        onOpenChange={(open) => {
          if (!open)
            setTrialModalDismissedForOrg(billingOrganizationId ?? null);
        }}
      >
        <DialogContent
          onPointerDownOutside={(e) => e.preventDefault()}
          onEscapeKeyDown={(e) => e.preventDefault()}
          data-testid="trial-decision-modal"
        >
          <DialogHeader>
            <DialogTitle>Choose how to continue</DialogTitle>
            <DialogDescription>
              Your trial has ended. Upgrade to keep paid features, or move this
              organization to the Free plan.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter className="gap-2">
            <Button
              type="button"
              variant="outline"
              disabled={isSelectingFreeAfterTrial}
              onClick={() => {
                void (async () => {
                  try {
                    await selectFreeAfterTrial();
                    toast.success("This organization is now on the Free plan.");
                  } catch {
                    toast.error("Could not update plan. Try again.");
                  }
                })();
              }}
            >
              {isSelectingFreeAfterTrial ? "Saving…" : "Choose free"}
            </Button>
            <Button
              type="button"
              onClick={() => {
                setTrialModalDismissedForOrg(billingOrganizationId ?? null);
                if (billingOrganizationId) {
                  applyNavigation(
                    `organizations/${billingOrganizationId}/billing`,
                    { updateHash: true },
                  );
                }
              }}
            >
              Upgrade
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </SidebarProvider>
  );

  return (
    <PreferencesStoreProvider
      themeMode={initialThemeMode}
      themePreset={initialThemePreset}
    >
      <WorkspaceClientConfigSync
        activeWorkspaceId={activeWorkspaceId}
        savedClientConfig={activeWorkspace?.clientConfig}
      />
      <AppStateProvider appState={effectiveAppState}>
        <Toaster />
        <div
          data-testid="app-shell-container"
          aria-hidden={
            shouldShowBillingHandoffOverlay ||
            shouldShowWorkspaceBootstrapOverlay ||
            undefined
          }
          className={
            shouldShowBillingHandoffOverlay || shouldShowWorkspaceBootstrapOverlay
              ? "pointer-events-none opacity-0"
              : undefined
          }
          inert={
            shouldShowBillingHandoffOverlay ||
            shouldShowWorkspaceBootstrapOverlay ||
            undefined
          }
        >
          <HostedShellGate
            state={
              isHostedChatRoute
                ? hostedChatShellGateState
                : hostedShellGateState
            }
            onSignIn={() => {
              if (sharedPathToken) {
                writeSharedSignInReturnPath(window.location.pathname);
              }
              if (sandboxPathToken) {
                writeSandboxSignInReturnPath(window.location.pathname);
              }
              signIn();
            }}
          >
            {isSharedChatRoute ? (
              <SharedServerChatPage
                pathToken={sharedPathToken}
                onExitSharedChat={() => setExitedSharedChat(true)}
              />
            ) : isSandboxChatRoute ? (
              <SandboxChatPage
                pathToken={sandboxPathToken}
                onExitSandboxChat={() => setExitedSandboxChat(true)}
              />
            ) : (
              appContent
            )}
          </HostedShellGate>
        </div>
        {shouldShowBillingHandoffOverlay ? (
          <BillingHandoffLoading overlay />
        ) : null}
        {shouldShowWorkspaceBootstrapOverlay ? (
          <LoadingScreen
            overlay
            testId="workspace-bootstrap-loading-overlay"
          />
        ) : null}
      </AppStateProvider>
    </PreferencesStoreProvider>
  );
}
