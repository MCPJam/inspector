import { useConvexAuth, useQuery } from "convex/react";
import {
  useCallback,
  createContext,
  useContext,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type ComponentProps,
} from "react";
import { useAuth } from "@workos-inc/authkit-react";
import { AlertTriangle, Loader2 } from "lucide-react";
import { toast } from "@/lib/toast";
import { MCPJamLimitDialog } from "./components/mcpjam-limit-dialog";
import { HomeTab } from "./components/HomeTab";
import { ServersTab } from "./components/ServersTab";
import { ToolsTab } from "./components/ToolsTab";
import { ResourcesTab } from "./components/ResourcesTab";
import { PromptsTab } from "./components/PromptsTab";
import { SkillsTab } from "./components/SkillsTab";
import { LearningTab } from "./components/LearningTab";
import { TasksTab } from "./components/TasksTab";
import { ActiveHostCapsResolverScope } from "./contexts/active-host-client-capabilities-context";
import type { EvalChatHandoff } from "./lib/eval-chat-handoff";
import { EvalsTab } from "./components/EvalsTab";
import { CiEvalsTab } from "./components/CiEvalsTab";
import { ViewsTab } from "./components/ViewsTab";
import { ChatboxesTab } from "./components/ChatboxesTab";
import { SettingsTab } from "./components/SettingsTab";
import { ApiKeysRoute } from "./components/settings/ApiKeysRoute";
import { ProjectSettingsTab } from "./components/ProjectSettingsTab";
import { ProjectClientConfigSync } from "./components/client-config/ProjectClientConfigSync";
import { ActiveHostServerReconciler } from "./components/ActiveHostServerReconciler";
import { TracingTab } from "./components/TracingTab";
import { AuthTab } from "./components/AuthTab";
import { OAuthFlowTab } from "./components/OAuthFlowTab";
import { ConformanceTab } from "./components/conformance/ConformancePanel";
import { HostCompatPage } from "./components/compat/HostCompatPage";
import { XAAFlowTab } from "./components/xaa/XAAFlowTab";
import { ErrorBoundary } from "./components/ui/error-boundary";
import { PlaygroundTab } from "./components/playground/PlaygroundTab";
import { EXCALIDRAW_SERVER_NAME } from "./lib/excalidraw-quick-connect";
import { isFirstRunEligible } from "./lib/onboarding-state";
import { ProfileTab } from "./components/ProfileTab";
import { BillingUpsellGate } from "./components/billing/BillingUpsellGate";
import { OrganizationsTab } from "./components/OrganizationsTab";
import { SupportTab } from "./components/SupportTab";
import { RegistryTab } from "./components/RegistryTab";
import { HostsTab } from "./components/HostsTab";
import { HostConfigCompareView } from "./components/hosts/comparison/HostConfigCompareView";
import { HostSectionTabs } from "./components/hosts/HostSectionTabs";
import { ConnectViewHeader } from "./components/hosts/ConnectViewHeader";
import { ComputerView } from "./components/computer/ComputerView";
import { useComputersEnabledState } from "./hooks/useComputersEnabled";
import { motion } from "framer-motion";
import { SNAPPY_RAIL } from "./components/hosts/transition-tokens";
import OAuthDebugCallback from "./components/oauth/OAuthDebugCallback";
import OAuthDesktopReturnNotice from "./components/oauth/OAuthDesktopReturnNotice";
import { MCPSidebar } from "./components/mcp-sidebar";
import {
  SidebarInset,
  SidebarProvider,
  useSidebar,
} from "./components/ui/sidebar";
import { AgentSidePanelMount } from "./components/mcpjam-agent/AgentSidePanelMount";
import {
  Alert,
  AlertDescription,
  AlertTitle,
} from "@mcpjam/design-system/alert";
import { Button } from "@mcpjam/design-system/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@mcpjam/design-system/dialog";
import { useAppState, type ServerWithName } from "./hooks/use-app-state";
import { useActorKey } from "./hooks/use-actor-key";
import {
  PreferencesStoreProvider,
  usePreferencesStore,
} from "./stores/preferences/preferences-provider";
import { Toaster } from "@mcpjam/design-system/sonner";
import { useElectronOAuth } from "./hooks/useElectronOAuth";
import { usePostHog, useFeatureFlagEnabled } from "posthog-js/react";
import { usePostHogIdentify } from "./hooks/usePostHogIdentify";
import { usePostHogOrgContext } from "./hooks/usePostHogOrgContext";
import { useDbUserBootstrapStatus } from "./contexts/db-user-ready-context";
import { AppStateProvider } from "./state/app-state-context";
import { ServerActionsProvider } from "./state/server-actions-context";
import { usePreviewedHostId } from "./hooks/use-previewed-client-id";
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
import LoadingScreen from "./components/LoadingScreen";
import { OccupationGate } from "./components/signup/OccupationGate";
import { Header } from "./components/Header";
import { ThemePreset } from "./types/preferences/theme";
import type {
  ActiveServerSelectorProps,
  PlaygroundServerSelectorProps,
} from "./components/ActiveServerSelector";
import { useViewQueries, useProjectServers } from "./hooks/useViews";
import { HostedShellGate } from "./components/hosted/HostedShellGate";
import { resolveHostedShellGateState } from "./components/hosted/hosted-shell-gate-state";
import {
  ChatboxChatPage,
  getChatboxPathTokenFromLocation,
} from "./components/hosted/ChatboxChatPage";
import { useApiContext } from "./hooks/hosted/use-hosted-api-context";
import { useLocalStateMigration } from "./hooks/use-local-state-migration";
import { AppReadyProvider } from "./hooks/use-app-ready";
import { useInspectorCommandBus } from "./hooks/use-inspector-command-bus";
import { HOSTED_MODE, NON_PROD_LOCKDOWN } from "./lib/config";
import {
  createInspectorCommandClientError,
  registerInspectorCommandHandler,
} from "./lib/inspector-command-handlers";
import { waitForUiCommit } from "./lib/wait-for-ui-commit";
import { subscribeToOAuthDebuggerRequests } from "./lib/oauth/oauth-debugger-navigation";
import {
  clearBillingSignInReturnPath,
  clearCheckoutIntentFromUrl,
  clearPersistedCheckoutIntent,
  hasInvalidCheckoutIntervalParam,
  hasInvalidCheckoutQueryParams,
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
import { isHostedHashTabAllowed } from "./lib/hosted-tab-policy";
import { buildOAuthTokensByServerId } from "./lib/oauth/oauth-tokens";
import type { OAuthTrace } from "./lib/oauth/oauth-trace";
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
  resolveHostedOAuthReturnPath,
} from "./lib/hosted-oauth-callback";
import {
  clearChatboxSignInReturnPath,
  readChatboxSession,
  readChatboxSignInReturnPath,
  writeChatboxSignInReturnPath,
} from "./lib/chatbox-session";
import {
  clearCliSignInReturnPath,
  readCliSignInReturnPath,
} from "./lib/cli-signin-return-path";
import {
  clearApiKeysSignInReturnPath,
  readApiKeysSignInReturnPath,
} from "./lib/api-keys-signin-return-path";
import {
  sanitizeHostedOAuthErrorMessage,
  clearHostedOAuthResumeMarker,
  writeHostedOAuthResumeMarker,
} from "./lib/hosted-oauth-resume";
import {
  completeHostedOAuthCallback,
  handleOAuthCallback,
} from "./lib/oauth/mcp-oauth";
import { buildElectronMcpCallbackUrl } from "./hooks/use-server-state";
import { disconnectAllRuntimeServers } from "./state/mcp-api";
import { getEffectiveProjectClientCapabilities } from "./lib/client-config";
import {
  getDefaultClientCapabilities,
  isKnownProtocolVersion,
  type McpProtocolVersion,
} from "@mcpjam/sdk/browser";
import { resolveEffectiveMcpProtocolVersion } from "./lib/client-config-v2";
import type { ProjectServerConfigDto } from "./lib/project-server-config";
import {
  buildHostsPath,
  buildOrganizationPath,
  buildEvalsPath,
  getInvalidOrganizationRouteNavigationTarget,
  getProjectSwitchNavigationTarget,
  navigationTargetToPath,
  navigateApp,
  pathnameToActiveTab,
  routePaths,
  type OrganizationRouteSection,
  useActiveTab,
  useAppNavigate,
  useCurrentOrgRoute,
} from "./lib/app-navigation";
import {
  Navigate,
  Outlet,
  UNSAFE_LocationContext,
  useOutletContext,
  useParams,
} from "react-router";
import { useProjectClientConfigSyncPending } from "./hooks/use-project-client-config-sync-pending";
import { ingestOAuthTraceLogs } from "./stores/traffic-log-store";
import { clearGuestSession, getGuestBearerToken } from "./lib/guest-session";
import type {
  NavigateInspectorCommand,
  OpenPlaygroundInspectorCommand,
  SelectServerInspectorCommand,
} from "@/shared/inspector-command.js";

const OCCUPATION_GATE_ROLLOUT_MS = Date.parse("2026-04-29T00:00:00.000Z");
// Accounts created on/after this ship date are treated as "new" for the
// first-run Playground redirect. Older accounts (created before the cutoff)
// are never redirected, regardless of their onboarding flag, so returning
// users always keep the Home landing.
const FIRST_RUN_PLAYGROUND_ROLLOUT_MS = Date.parse("2026-06-16T00:00:00.000Z");
const AUTH_EXIT_RUNTIME_CLEANUP_TIMEOUT_MS = 2_500;

function getHostedOAuthCallbackErrorMessage(): string {
  const params = new URLSearchParams(window.location.search);
  const error = params.get("error");
  const description = params.get("error_description");

  if (error === "access_denied" && !description) {
    return "Authorization was cancelled. Try again.";
  }

  return sanitizeHostedOAuthErrorMessage(
    description || error,
    "Authorization could not be completed. Try again."
  );
}

function clearHostedCallbackRetryState() {
  clearHostedOAuthPendingState();
  clearHostedOAuthResumeMarker();
  clearGuestSession();
  localStorage.removeItem("mcp-oauth-pending");
  localStorage.removeItem("mcp-oauth-return-hash");

  for (const storage of [window.localStorage, window.sessionStorage]) {
    const workosKeys: string[] = [];

    for (let index = 0; index < storage.length; index += 1) {
      const key = storage.key(index);
      if (key && /workos/i.test(key)) {
        workosKeys.push(key);
      }
    }

    for (const key of workosKeys) {
      storage.removeItem(key);
    }
  }
}

const OAUTH_DEBUGGER_SECRET_PATTERNS = [
  /\b(access_token|refresh_token|id_token|client_secret|clientSecret|code_verifier|code|state)\b(\s*[:=]\s*)("[^"]*"|'[^']*'|[^\s&,;]+)/gi,
  /\bBearer\s+[A-Za-z0-9._~+/=-]+\b/gi,
  /\bBasic\s+[A-Za-z0-9+/=._~-]+\b/gi,
];

function sanitizeOAuthDebuggerText(value: string | null | undefined): string {
  if (!value) {
    return "";
  }

  return OAUTH_DEBUGGER_SECRET_PATTERNS.reduce(
    (sanitized, pattern) =>
      sanitized.replace(pattern, (...args) => {
        const key = typeof args[1] === "string" ? args[1] : undefined;
        const separator = typeof args[2] === "string" ? args[2] : undefined;
        return key && separator ? `${key}${separator}[redacted]` : "[redacted]";
      }),
    value
  );
}

function sanitizeOAuthDebuggerError(error: Error | null) {
  return {
    name: sanitizeOAuthDebuggerText(error?.name ?? "Error"),
    message: sanitizeOAuthDebuggerText(error?.message ?? "Unknown error"),
    stack: sanitizeOAuthDebuggerText(error?.stack),
  };
}

function formatOAuthDebuggerErrorDetails(error: Error | null): string {
  const sanitized = sanitizeOAuthDebuggerError(error);
  return [
    "OAuth Debugger error",
    `Name: ${sanitized.name}`,
    `Message: ${sanitized.message}`,
    sanitized.stack ? `Stack:\n${sanitized.stack}` : "",
  ]
    .filter(Boolean)
    .join("\n\n");
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

function UserSetupError() {
  return (
    <div
      className="flex min-h-screen flex-col items-center justify-center gap-4 p-6 text-center"
      data-testid="user-setup-error"
    >
      <div className="max-w-md space-y-2">
        <h1 className="text-xl font-semibold">Could not finish setup</h1>
        <p className="text-sm text-muted-foreground">
          We could not create your MCPJam user record. Refresh and try again.
        </p>
      </div>
      <button
        type="button"
        className="rounded bg-primary px-4 py-2 text-sm font-medium text-primary-foreground"
        onClick={() => window.location.reload()}
      >
        Refresh
      </button>
    </div>
  );
}

function resolveDeletedOrganizationFallbackId(
  organizations: ReadonlyArray<{ _id: string; myRole?: string }>
): string | undefined {
  const firstOwnedOrganization = organizations.find(
    (organization) => organization.myRole === "owner"
  );
  return firstOwnedOrganization?._id ?? organizations[0]?._id;
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
  const { isMobile } = useSidebar();
  if (hidden && !isMobile) {
    return null;
  }

  return <Header {...props} />;
}

type AppRouteContext = Record<string, any>;

const AppRouteReactContext = createContext<AppRouteContext | null>(null);

function useAppRouteContext() {
  const context = useContext(AppRouteReactContext);
  return context ?? useOutletContext<AppRouteContext>();
}

function NoRouterRouteBody({ activeTab }: { activeTab: string }) {
  switch (activeTab) {
    case "registry":
      return <RegistryRoute />;
    case "tools":
      return <ToolsRoute />;
    case "resources":
      return <ResourcesRoute />;
    case "prompts":
      return <PromptsRoute />;
    case "tasks":
      return <TasksRoute />;
    case "auth":
      return <AuthRoute />;
    case "skills":
      return <SkillsRoute />;
    case "learning":
      return <LearningRoute />;
    case "conformance":
      return <ConformanceRoute />;
    case "compatibility":
      return <CompatibilityRoute />;
    case "oauth-flow":
      return <OAuthFlowRoute />;
    case "xaa-flow":
      return <XAAFlowRoute />;
    case "tracing":
      return <TracingRoute />;
    case "clients":
      return <HostsRoute />;
    case "host-compare":
      return <HostCompareRoute />;
    case "computer":
      return <ComputerRoute />;
    case "chatboxes":
      return <ChatboxesRoute />;
    case "playground":
      return <PlaygroundRoute />;
    case "views":
      return <ViewsRoute />;
    case "support":
      return <SupportRoute />;
    case "settings":
      return <SettingsRoute />;
    case "profile":
      return <ProfileRoute />;
    case "project-settings":
      return <ProjectSettingsRoute />;
    case "organizations":
      return <OrganizationsRoute />;
    case "evals":
      return <EvalsRoute />;
    case "ci-evals":
      return <CiEvalsRoute />;
    case "home":
      return <HomeRoute />;
    case "servers":
    default:
      return <ServersRoute />;
  }
}

function ActiveBillingUpsellGate() {
  const {
    activeTabBillingFeature,
    shellBillingStatus,
    upgradePlanForActiveTab,
    billingOrganizationId,
    navigateToTarget,
  } = useAppRouteContext();

  return (
    <BillingUpsellGate
      feature={activeTabBillingFeature}
      currentPlan={
        shellBillingStatus?.effectivePlan ?? shellBillingStatus?.plan ?? "free"
      }
      upgradePlan={upgradePlanForActiveTab}
      canManageBilling={shellBillingStatus?.canManageBilling ?? false}
      onNavigateToBilling={() => {
        if (billingOrganizationId) {
          navigateToTarget(`organizations/${billingOrganizationId}/billing`);
        }
      }}
    />
  );
}

export function ServersRoute() {
  const { convexProjectId, isAuthenticated } = useAppRouteContext();
  const navigate = useAppNavigate();

  // From /servers, "select a host" means navigate to /hosts/:id. State sync
  // happens in HostsRoute via the URL → hostsTabSelectedHostId effect, so
  // here we only need to drive the URL.
  const handleSelectHost = useCallback(
    (next: string | null) => {
      navigate(next ? buildHostsPath(next) : routePaths.servers);
    },
    [navigate]
  );

  if (!isAuthenticated) {
    return <ServersTabBody />;
  }

  return (
    <HostsTab
      projectId={convexProjectId}
      isAuthenticated={isAuthenticated}
      selectedHostId={null}
      onSelectHost={handleSelectHost}
      serversTabElement={<ServersTabBody />}
    />
  );
}

function ServersTabBody() {
  const {
    projectServers,
    handleConnect,
    handleDisconnect,
    handleReconnect,
    handleUpdate,
    handleRemoveServer,
    projects,
    activeProjectId,
    activeProjectBillingOrganizationId,
    pendingDashboardOAuth,
    isBillingContextPending,
    isAuthLoading,
    isLoadingRemoteProjects,
    areServersHydrated,
    isWorkOsLoading,
    handleProjectShared,
    handleLeaveProject,
    registryEnabled,
    handleNavigate,
  } = useAppRouteContext();

  return (
    <ServersTab
      projectServers={projectServers}
      onConnect={handleConnect}
      onDisconnect={handleDisconnect}
      onReconnect={handleReconnect}
      onUpdate={handleUpdate}
      onRemove={handleRemoveServer}
      projects={projects}
      activeProjectId={activeProjectId}
      organizationId={activeProjectBillingOrganizationId}
      pendingDashboardOAuth={pendingDashboardOAuth}
      isBillingContextPending={isBillingContextPending}
      isAuthHydrating={isWorkOsLoading || isAuthLoading}
      isLoadingProjects={isLoadingRemoteProjects}
      areServersHydrated={areServersHydrated}
      onProjectShared={handleProjectShared}
      onLeaveProject={() => handleLeaveProject(activeProjectId)}
      isRegistryEnabled={registryEnabled === true}
      onNavigateToRegistry={
        registryEnabled === true ? () => handleNavigate("registry") : undefined
      }
    />
  );
}

export function HostsRoute() {
  const {
    convexProjectId,
    hostsTabSelectedHostId,
    isAuthenticated,
    setHostsTabSelectedHostId,
  } = useAppRouteContext();
  const [previewedHostId] = usePreviewedHostId(convexProjectId);
  const params = useParams<{ hostId?: string }>();
  const navigate = useAppNavigate();
  const urlHostId = useMemo(() => {
    if (!params.hostId) return null;
    try {
      return decodeURIComponent(params.hostId);
    } catch {
      return params.hostId;
    }
  }, [params.hostId]);

  // URL is the source of truth for the open host canvas. Sync into shared
  // state so `GlobalHostBar`, `onCanvasReplaceHost`, and other surfaces that
  // still read `hostsTabSelectedHostId` stay aligned.
  useEffect(() => {
    if (hostsTabSelectedHostId === urlHostId) return;
    setHostsTabSelectedHostId(urlHostId);
  }, [urlHostId, hostsTabSelectedHostId, setHostsTabSelectedHostId]);

  const handleSelectHost = useCallback(
    (next: string | null) => {
      navigate(next ? buildHostsPath(next) : routePaths.hosts);
    },
    [navigate]
  );

  if (!isAuthenticated) {
    return <ServersTabBody />;
  }

  return (
    <HostsTab
      projectId={convexProjectId}
      isAuthenticated={isAuthenticated}
      selectedHostId={urlHostId ?? previewedHostId}
      onSelectHost={handleSelectHost}
      serversTabElement={<ServersTabBody />}
    />
  );
}

/** Where the embed (caniuse.dev) entry point sends people for the full product. */
const MAIN_PRODUCT_URL = "https://app.mcpjam.com";

export function HostCompareRoute({ bare = false }: { bare?: boolean } = {}) {
  const { convexProjectId, isAuthenticated } = useAppRouteContext();
  const [previewedHostId] = usePreviewedHostId(convexProjectId);
  const navigate = useAppNavigate();

  const compareView = (
    <HostConfigCompareView
      projectId={convexProjectId}
      isAuthenticated={isAuthenticated}
    />
  );

  // Mirror the gating HostsRoute uses: when signed out, Compare has no peer
  // Servers/Client tabs to switch to, so render bare. `bare` forces the same
  // for the chrome-less embed route (caniuse.dev) regardless of auth.
  if (bare || !isAuthenticated) {
    return compareView;
  }

  return (
    <motion.div
      key="host-compare"
      initial={{ opacity: 0, y: 8 }}
      animate={{ opacity: 1, y: 0 }}
      transition={SNAPPY_RAIL}
      className="flex h-full min-h-0 flex-col"
    >
      <ConnectViewHeader
        value="host"
        previewedHostId={previewedHostId}
        onChange={(next) => {
          if (next === "servers") {
            navigate(routePaths.servers);
          } else if (next === "host" && previewedHostId) {
            navigate(buildHostsPath(previewedHostId));
          } else if (next === "computer") {
            navigate(routePaths.computer);
          }
        }}
        rightSlot={
          // Host/Compare sub-nav inline in the header row (single bar) rather
          // than stacked beneath the primary nav.
          <div className="flex min-w-0 items-center justify-center md:justify-end">
            <HostSectionTabs
              value="compare"
              hostEnabled={Boolean(previewedHostId)}
              onSelect={(next) => {
                if (next === "host" && previewedHostId) {
                  navigate(buildHostsPath(previewedHostId));
                }
              }}
            />
          </div>
        }
      />
      <div className="min-h-0 flex-1">{compareView}</div>
    </motion.div>
  );
}

export function ComputerRoute() {
  const { convexProjectId, isAuthenticated } = useAppRouteContext();
  const [previewedHostId] = usePreviewedHostId(convexProjectId);
  const navigate = useAppNavigate();
  const computersEnabled = useComputersEnabledState();

  // Only redirect on an explicit `false`. While PostHog hydrates the flag is
  // `undefined`; bouncing then would strand a flagged-in user who cold-loads
  // /computer directly (the redirect fires before the flag resolves). Render
  // nothing until it settles — disabled users get the bounce a beat later.
  if (computersEnabled === false) {
    return <Navigate to={routePaths.servers} replace />;
  }
  if (computersEnabled === undefined) {
    return null;
  }

  const computerView = (
    <ComputerView
      projectId={convexProjectId}
      isAuthenticated={isAuthenticated}
    />
  );

  if (!isAuthenticated) {
    return computerView;
  }

  return (
    <motion.div
      key="computer"
      initial={{ opacity: 0, y: 8 }}
      animate={{ opacity: 1, y: 0 }}
      transition={SNAPPY_RAIL}
      className="flex h-full min-h-0 flex-col"
    >
      <ConnectViewHeader
        value="computer"
        previewedHostId={previewedHostId}
        onChange={(next) => {
          if (next === "servers") {
            navigate(routePaths.servers);
          } else if (next === "compare") {
            navigate(routePaths.hostCompare);
          } else if (next === "host" && previewedHostId) {
            navigate(buildHostsPath(previewedHostId));
          }
        }}
      />
      <div className="min-h-0 flex-1">{computerView}</div>
    </motion.div>
  );
}

export function RegistryRoute() {
  const {
    registryEnabled,
    convexProjectId,
    isAuthenticated,
    handleConnect,
    handleDisconnect,
    handleNavigate,
    projectServers,
  } = useAppRouteContext();

  if (registryEnabled !== true) return null;

  return (
    <RegistryTab
      projectId={convexProjectId}
      isAuthenticated={isAuthenticated}
      onConnect={handleConnect}
      onDisconnect={handleDisconnect}
      onNavigate={handleNavigate}
      servers={projectServers}
    />
  );
}

export function ToolsRoute() {
  const { selectedMCPConfig, selectedServerEntry, appState, activeHost } =
    useAppRouteContext();
  const prefHostStyle = usePreferencesStore((state) => state.hostStyle);
  const hostStyle = activeHost?.hostStyle ?? prefHostStyle;
  return (
    <ActiveHostCapsResolverScope activeHost={activeHost} hostStyle={hostStyle}>
      <div className="h-full overflow-hidden">
        <ToolsTab
          serverConfig={selectedMCPConfig}
          serverName={appState.selectedServer}
          serverConnectionStatus={
            selectedServerEntry?.connectionStatus ?? "disconnected"
          }
        />
      </div>
    </ActiveHostCapsResolverScope>
  );
}

export function EvalsRoute() {
  const {
    billingUiEnabled,
    activeTabBillingLocked,
    activeTabBillingFeature,
    convexProjectId,
    ensureServersReady,
    handleContinueEvalInChat,
    handleConnect,
  } = useAppRouteContext();

  if (billingUiEnabled && activeTabBillingLocked && activeTabBillingFeature) {
    return <ActiveBillingUpsellGate />;
  }

  return (
    <EvalsTab
      projectId={convexProjectId}
      ensureServersReady={ensureServersReady}
      onContinueInChat={handleContinueEvalInChat}
      handleConnect={handleConnect}
    />
  );
}

export function CiEvalsRoute() {
  const {
    evaluateRunsFlagsLoaded,
    evaluateRunsEnabled,
    billingUiEnabled,
    activeTabBillingLocked,
    activeTabBillingFeature,
    convexProjectId,
    ensureServersReady,
  } = useAppRouteContext();

  if (!evaluateRunsFlagsLoaded) {
    return (
      <div className="flex h-full min-h-[320px] items-center justify-center">
        <div className="text-center">
          <Loader2 className="mx-auto h-8 w-8 animate-spin text-primary" />
          <p className="mt-4 text-sm text-muted-foreground">Loading Runs...</p>
        </div>
      </div>
    );
  }

  if (evaluateRunsEnabled !== true) return null;

  if (billingUiEnabled && activeTabBillingLocked && activeTabBillingFeature) {
    return <ActiveBillingUpsellGate />;
  }

  return (
    <CiEvalsTab
      convexProjectId={convexProjectId}
      ensureServersReady={ensureServersReady}
    />
  );
}

export function ViewsRoute() {
  const { appState, activeProjectId, handleUpdateHostContext } =
    useAppRouteContext();

  return (
    <ViewsTab
      selectedServer={appState.selectedServer}
      activeProjectId={activeProjectId}
      onSaveHostContext={handleUpdateHostContext}
    />
  );
}

export function ConformanceRoute() {
  const { selectedServerEntry } = useAppRouteContext();
  return <ConformanceTab server={selectedServerEntry ?? null} />;
}

export function CompatibilityRoute() {
  const { appState, selectedServerEntry, activeProjectId, setSelectedServer } =
    useAppRouteContext();
  const connectedServers = Object.values<ServerWithName>(
    appState.servers,
  ).filter((s) => s.connectionStatus === "connected");
  // The page resolves the detail against `servers` (ignoring a stale/
  // disconnected global selection), so it's safe to pass the raw selection.
  return (
    <HostCompatPage
      servers={connectedServers}
      selectedServer={selectedServerEntry ?? null}
      onSelectServer={setSelectedServer}
      projectId={activeProjectId}
    />
  );
}

// `/chatboxes` is the publish surface (link / mode / members / sessions /
// clusters) for the chatbox bound 1:1 to the currently-selected host.
// Navigation between chatboxes flows through the global host bar — pick
// a host, manage its chatbox here. There is no chatbox list; the host
// list lives in Connect.
export function ChatboxesRoute() {
  const {
    billingUiEnabled,
    activeTabBillingLocked,
    activeTabBillingFeature,
    convexProjectId,
    isAuthenticated,
  } = useAppRouteContext();

  if (billingUiEnabled && activeTabBillingLocked && activeTabBillingFeature) {
    return <ActiveBillingUpsellGate />;
  }

  return (
    <ChatboxesTab
      projectId={convexProjectId}
      isAuthenticated={isAuthenticated}
    />
  );
}

export function ResourcesRoute() {
  const { selectedMCPConfig, selectedServerEntry, appState } =
    useAppRouteContext();
  return (
    <div className="h-full overflow-hidden">
      <ResourcesTab
        serverConfig={selectedMCPConfig}
        serverName={appState.selectedServer}
        serverConnectionStatus={
          selectedServerEntry?.connectionStatus ?? "disconnected"
        }
      />
    </div>
  );
}

export function PromptsRoute() {
  const { selectedMCPConfig, selectedServerEntry, appState } =
    useAppRouteContext();
  return (
    <div className="h-full overflow-hidden">
      <PromptsTab
        serverConfig={selectedMCPConfig}
        serverName={appState.selectedServer}
        serverConnectionStatus={
          selectedServerEntry?.connectionStatus ?? "disconnected"
        }
      />
    </div>
  );
}

export function SkillsRoute() {
  const { convexProjectId } = useAppRouteContext();
  const computersEnabled = useComputersEnabledState();

  // In hosted mode skills live on the project's Computer, so the route is
  // gated on the Computer flag — mirror ComputerRoute's tri-state: redirect
  // only on an explicit `false`, render nothing while PostHog hydrates (so a
  // flagged-in user cold-loading /skills isn't bounced before the flag
  // resolves). Local mode is ungated (local FS skills always work).
  if (HOSTED_MODE) {
    if (computersEnabled === false) {
      return <Navigate to={routePaths.servers} replace />;
    }
    if (computersEnabled === undefined) {
      return null;
    }
  }

  return (
    <SkillsTab
      projectId={convexProjectId}
      computersEnabled={computersEnabled === true}
    />
  );
}

export function LearningRoute() {
  return <LearningTab />;
}

export function TasksRoute() {
  const { selectedMCPConfig, appState } = useAppRouteContext();
  return (
    <div className="h-full overflow-hidden">
      <TasksTab
        serverConfig={selectedMCPConfig}
        serverName={appState.selectedServer}
        isActive
      />
    </div>
  );
}

export function AuthRoute() {
  const { selectedMCPConfig, appState } = useAppRouteContext();
  return (
    <AuthTab
      serverConfig={selectedMCPConfig}
      serverEntry={appState.servers[appState.selectedServer]}
      serverName={appState.selectedServer}
    />
  );
}

export function OAuthFlowRoute() {
  const {
    appState,
    setSelectedServer,
    saveServerConfigWithoutConnecting,
    handleConnectWithTokensFromOAuthFlow,
    handleRefreshTokensFromOAuthFlow,
    oauthServerModalNonce,
    posthog,
  } = useAppRouteContext();

  return (
    <ErrorBoundary
      fallback={({ error, reset }) => {
        const copyDetails = () => {
          const details = formatOAuthDebuggerErrorDetails(error);
          void navigator.clipboard
            ?.writeText(details)
            .then(() => toast.success("Copied OAuth debugger error"))
            .catch(() => toast.error("Could not copy OAuth debugger error"));
        };

        return (
          <div className="flex h-full items-center justify-center p-6">
            <div className="max-w-md space-y-4 text-center">
              <AlertTriangle className="mx-auto size-10 text-destructive" />
              <div className="space-y-2">
                <h2 className="text-lg font-semibold">
                  OAuth Debugger crashed
                </h2>
                <p className="text-sm text-muted-foreground">
                  {sanitizeOAuthDebuggerError(error).message}
                </p>
              </div>
              <div className="flex justify-center gap-2">
                <Button variant="outline" onClick={reset}>
                  Try again
                </Button>
                <Button variant="outline" onClick={copyDetails}>
                  Copy details
                </Button>
              </div>
            </div>
          </div>
        );
      }}
      onError={(error, errorInfo) => {
        const sanitizedError = sanitizeOAuthDebuggerError(error);
        posthog.capture("oauth_debugger_error_boundary", {
          name: sanitizedError.name,
          message: sanitizedError.message,
          stack: sanitizedError.stack,
          componentStack: sanitizeOAuthDebuggerText(errorInfo.componentStack),
        });
      }}
    >
      <OAuthFlowTab
        serverConfigs={appState.servers}
        selectedServerName={appState.selectedServer}
        onSelectServer={setSelectedServer}
        onSaveServerConfig={saveServerConfigWithoutConnecting}
        onConnectWithTokens={handleConnectWithTokensFromOAuthFlow}
        onRefreshTokens={handleRefreshTokensFromOAuthFlow}
        openProfileModalSignal={oauthServerModalNonce}
      />
    </ErrorBoundary>
  );
}

export function XAAFlowRoute() {
  const {
    xaaEnabled,
    appState,
    displayServerConfigs,
    activeOrganizationId,
    convexProjectId,
    setSelectedServer,
    saveServerConfigWithoutConnecting,
    xaaServerModalNonce,
  } = useAppRouteContext();
  if (xaaEnabled !== true) return null;

  return (
    <ErrorBoundary
      fallback={
        <div className="flex items-center justify-center h-full text-muted-foreground">
          Something went wrong in the XAA Debugger. Try refreshing the page.
        </div>
      }
    >
      <XAAFlowTab
        // The saved project catalog (clientId, scopes, hasClientSecret,
        // xaaAuthzIssuer), not the runtime connection entries — the latter
        // drop the persisted OAuth config, so the Configure modal and the
        // runner saw a confidential server as a public client with no issuer.
        serverConfigs={displayServerConfigs}
        selectedServerName={appState.selectedServer}
        organizationId={activeOrganizationId ?? null}
        projectId={convexProjectId ?? null}
        onSelectServer={setSelectedServer}
        onSaveServerConfig={saveServerConfigWithoutConnecting}
        openServerModalSignal={xaaServerModalNonce}
      />
    </ErrorBoundary>
  );
}

export function TracingRoute() {
  return <TracingTab />;
}

export function PlaygroundRoute() {
  const {
    activeHost,
    activeProject,
    activeProjectId,
    appState,
    ensureServersReady,
    evalChatHandoff,
    handleConnect,
    handleUpdateHostContext,
    isAuthenticated,
    isSelectedServerSyncing,
    isWorkOsLoading,
    playgroundServerSelectorProps,
    projectServers,
    remoteFirstRunOnboardingShown,
    selectedMCPConfig,
    setPlaygroundOnboarding,
    setEvalChatHandoff,
    workOsUser,
  } = useAppRouteContext();

  return (
    <PlaygroundTab
      serverConfig={selectedMCPConfig}
      serverName={appState.selectedServer}
      servers={projectServers}
      activeProjectId={activeProjectId}
      sharedProjectId={activeProject?.sharedProjectId ?? null}
      isSignedInWithWorkOs={!!workOsUser}
      isWorkOsAuthLoading={isWorkOsLoading}
      isConvexAuthenticated={isAuthenticated}
      isProjectProvisioned={Boolean(activeProject?.sharedProjectId)}
      hasSeenFirstRunOnboarding={remoteFirstRunOnboardingShown}
      isServerSyncing={isSelectedServerSyncing}
      onConnect={handleConnect}
      onSaveHostContext={handleUpdateHostContext}
      ensureServersReady={ensureServersReady}
      onOnboardingChange={setPlaygroundOnboarding}
      playgroundServerSelectorProps={playgroundServerSelectorProps}
      activeHost={activeHost}
      evalChatHandoff={evalChatHandoff}
      onEvalChatHandoffConsumed={(id) =>
        setEvalChatHandoff((current: EvalChatHandoff | null) =>
          current?.id === id ? null : current
        )
      }
    />
  );
}

export function ProjectSettingsRoute() {
  const {
    activeProjectId,
    activeProject,
    convexProjectId,
    projectServers,
    activeOrganizationName,
    handleUpdateProject,
    handleDeleteProject,
    handleProjectShared,
    defaultHubRoute,
    handleNavigate,
  } = useAppRouteContext();

  return (
    <ProjectSettingsTab
      activeProjectId={activeProjectId}
      project={activeProject}
      convexProjectId={convexProjectId}
      projectServers={projectServers}
      organizationName={activeOrganizationName}
      onUpdateProject={handleUpdateProject}
      onDeleteProject={handleDeleteProject}
      onProjectShared={handleProjectShared}
      onNavigateAway={() => handleNavigate(defaultHubRoute)}
    />
  );
}

export function SettingsRoute() {
  const { activeOrganizationId, handleNavigate } = useAppRouteContext();
  return (
    <SettingsTab
      activeOrganizationId={activeOrganizationId}
      onNavigate={handleNavigate}
    />
  );
}

export function ApiKeysSettingsRoute() {
  const { activeOrganizationId } = useAppRouteContext();
  return <ApiKeysRoute activeOrganizationId={activeOrganizationId} />;
}

export function SupportRoute() {
  return <SupportTab />;
}

export function ProfileRoute() {
  return <ProfileTab />;
}

export function OrganizationsRoute() {
  const {
    routeOrganizationId,
    routeOrganizationSection,
    checkoutIntentForBilling,
    consumeCheckoutIntent,
    handleCheckoutIntentNavigationStarted,
    handleOrganizationDeleted,
  } = useAppRouteContext();

  return (
    <OrganizationsTab
      organizationId={routeOrganizationId}
      section={routeOrganizationSection ?? "overview"}
      checkoutIntent={checkoutIntentForBilling}
      onCheckoutIntentConsumed={consumeCheckoutIntent}
      onCheckoutIntentNavigationStarted={handleCheckoutIntentNavigationStarted}
      onOrganizationDeleted={handleOrganizationDeleted}
    />
  );
}

export function ChatAliasRoute() {
  return <Navigate to={routePaths.playground} replace />;
}

export function ServersRedirectRoute() {
  return <Navigate to={routePaths.servers} replace />;
}

export function HomeRoute() {
  const { activeProjectId, homeOrganizationId, isHomeContextResolving } =
    useAppRouteContext();
  return (
    <HomeTab
      // Membership-validated org for `/home` (the route carries none, so it is
      // derived from the active project and checked against the org list — see
      // App). Null → the welcome "Get started" state.
      organizationId={homeOrganizationId ?? null}
      projectId={activeProjectId ?? null}
      isContextLoading={isHomeContextResolving}
    />
  );
}

export default function App() {
  const activeTab = useActiveTab();
  const currentOrgRoute = useCurrentOrgRoute();
  const [hostsTabSelectedHostId, setHostsTabSelectedHostId] = useState<
    string | null
  >(null);
  // The "active host" is unified: one selection drives the Chat tab, the
  // Servers/Playground/Hosts top-bar preview, and every MCP `initialize`
  // handshake the inspector performs. `usePreviewedHostId` is the canonical
  // storage (localStorage-backed, project-scoped) — useAppState resolves the
  // hydrated config from it internally so consumers see one source of truth.
  const [evalChatHandoff, setEvalChatHandoff] =
    useState<EvalChatHandoff | null>(null);
  const [
    optimisticallyDeletedOrganizationIds,
    setOptimisticallyDeletedOrganizationIds,
  ] = useState<string[]>([]);
  const [playgroundOnboarding, setPlaygroundOnboarding] = useState(false);
  // Bumped to ask the active debugger route to open its own "configure server"
  // modal (XAA / OAuth) instead of the generic Add Server modal — see the
  // onAddServerRequested wiring on the header server picker below.
  const [xaaServerModalNonce, setXaaServerModalNonce] = useState(0);
  const [oauthServerModalNonce, setOauthServerModalNonce] = useState(0);
  const [callbackCompleted, setCallbackCompleted] = useState(false);
  const [callbackRecoveryExpired, setCallbackRecoveryExpired] = useState(false);
  const billingDeepLinkNavRef = useRef(false);
  /** True after we read valid plan/interval from the URL and stripped query params; avoids clearing session on the next /billing tick. */
  const billingCheckoutQueryConsumedRef = useRef(false);
  const [pendingCheckoutIntent, setPendingCheckoutIntent] =
    useState<CheckoutIntent | null>(() => getInitialPendingCheckoutIntent());
  const posthog = usePostHog();
  const [evaluateRunsFlagsLoaded, setEvaluateRunsFlagsLoaded] = useState(
    () => posthog.featureFlags?.hasLoadedFlags === true
  );
  const billingEntitlementsUiEnabled = useFeatureFlagEnabled(
    "billing-entitlements-ui"
  );
  const learningEnabled = useFeatureFlagEnabled("mcpjam-learning");
  const registryEnabled = useFeatureFlagEnabled("registry-enabled");
  const conformanceEnabled = useFeatureFlagEnabled("mcpjam-conformance");
  const compatibilityEnabled = useFeatureFlagEnabled("mcpjam-compatibility");
  const evaluateRunsEnabled = useFeatureFlagEnabled("evaluate-ci");
  const xaaEnabled = useFeatureFlagEnabled("xaa");
  const {
    getAccessToken,
    signIn,
    signOut,
    user: workOsUser,
    isLoading: isWorkOsLoading,
  } = useAuth();
  const { isAuthenticated, isLoading: isAuthLoading } = useConvexAuth();
  const actorKey = useActorKey();
  const currentUser = useQuery(
    "users:getCurrentUser" as any,
    isAuthenticated ? ({} as any) : "skip"
  );
  // Keyed off the stored callback context rather than the platform: the
  // chatbox runtime (and its OAuth flows) runs on local/desktop builds too,
  // and the completion effect below is already context-gated.
  const [hostedOAuthHandling, setHostedOAuthHandling] = useState(() => {
    const callbackContext = getHostedOAuthCallbackContext();
    return callbackContext != null && callbackContext.surface !== "project";
  });
  const [exitedChatboxChat, setExitedChatboxChat] = useState(false);
  // The published-chatbox runtime route (`/chatbox/<slug>/<token>`, plus the
  // sessionStorage fallback that survives the post-redeem token strip) is
  // platform-uniform: it resolves on hosted, local, and desktop builds
  // alike. Capability gating happens downstream — redeem failures surface
  // through ChatboxChatPage's error states — so local dev gets the same
  // share-link and Preview-pane behavior as production.
  const chatboxPathToken = getChatboxPathTokenFromLocation();
  const chatboxSession = readChatboxSession();
  const hostedRouteKind = useMemo(() => {
    if (chatboxPathToken) {
      return "chatbox" as const;
    }

    if (chatboxSession) {
      return "chatbox" as const;
    }

    return null;
  }, [chatboxPathToken, chatboxSession]);
  const isChatboxChatRoute =
    !exitedChatboxChat && hostedRouteKind === "chatbox";

  // Chrome-less host-compare for vanity domains (caniuse.dev): rendered
  // full-bleed without the sidebar/header, and the first-run onboarding
  // redirect is suppressed so guests land directly on the comparison.
  const isBareCompareRoute =
    window.location.pathname === routePaths.embedHostCompare;

  useEffect(() => {
    setEvaluateRunsFlagsLoaded(posthog.featureFlags?.hasLoadedFlags === true);

    return posthog.onFeatureFlags(() => {
      setEvaluateRunsFlagsLoaded(posthog.featureFlags?.hasLoadedFlags === true);
    });
  }, [posthog]);
  const defaultHubRoute = useMemo((): "home" | "connect" | "servers" => {
    return "home";
  }, []);
  const isHostedChatRoute = isChatboxChatRoute;
  const locationContext = useContext(UNSAFE_LocationContext);
  const routeOrganizationId = currentOrgRoute?.orgId;
  const routeOrganizationSection = currentOrgRoute?.orgSection;
  const { isEnsuringUser, isUserReady } = useDbUserBootstrapStatus();
  const { sortedOrganizations, isLoading: isLoadingOrganizations } =
    useOrganizationQueries({ isAuthenticated });
  useEffect(() => {
    if (isLoadingOrganizations) {
      return;
    }

    setOptimisticallyDeletedOrganizationIds((currentIds) => {
      const nextIds = currentIds.filter((organizationId) =>
        sortedOrganizations.some((org) => org._id === organizationId)
      );
      return nextIds.length === currentIds.length &&
        nextIds.every(
          (organizationId, index) => organizationId === currentIds[index]
        )
        ? currentIds
        : nextIds;
    });
  }, [isLoadingOrganizations, sortedOrganizations]);
  const effectiveOrganizations = useMemo(
    () =>
      sortedOrganizations.filter(
        (organization) =>
          !optimisticallyDeletedOrganizationIds.includes(organization._id)
      ),
    [optimisticallyDeletedOrganizationIds, sortedOrganizations]
  );
  const hasRouteOrganization = !!routeOrganizationId
    ? effectiveOrganizations.some((org) => org._id === routeOrganizationId)
    : false;

  // Handle hosted OAuth callback: claim the callback before any hosted page renders.
  useEffect(() => {
    // Wait for Convex/WorkOS auth to settle before deciding signed-in vs guest
    // bearer. On post-redirect mount the first render sees
    // isAuthenticated=false while isAuthLoading=true; routing a signed-in
    // user's completion through the guest-bearer branch materializes a fresh
    // anonymous user with no chatboxAccess row and 403s on
    // /web/oauth/complete + /web/oauth/session/progress, then clears the
    // pending marker so the post-settle re-run can't recover.
    if (isAuthLoading) {
      return;
    }
    const callbackContext = getHostedOAuthCallbackContext();
    if (!callbackContext || callbackContext.surface === "project") {
      setHostedOAuthHandling(false);
      return;
    }

    const urlParams = new URLSearchParams(window.location.search);
    const code = urlParams.get("code");
    const error = urlParams.get("error");
    const state = urlParams.get("state");

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
      navigateApp(resolveHostedOAuthReturnPath(callbackContext), {
        replace: true,
      });
    };

    if (error || !code) {
      finalizeHostedOAuth(getHostedOAuthCallbackErrorMessage());
      setHostedOAuthHandling(false);
      return;
    }

    const handleLiveOAuthTrace = (oauthTrace: OAuthTrace) => {
      const serverId = callbackContext.serverId ?? callbackContext.serverName;
      if (!serverId) {
        return;
      }
      ingestOAuthTraceLogs({
        serverId,
        serverName: callbackContext.serverName,
        trace: oauthTrace,
      });
    };

    const hasHostedServerContext =
      !!callbackContext.projectId && !!callbackContext.serverId;
    const isGuestChatboxSessionCallback =
      !isAuthenticated &&
      !!callbackContext.chatboxId &&
      !!callbackContext.sessionId;
    const shouldUseHostedCompletion =
      hasHostedServerContext &&
      (isAuthenticated || isGuestChatboxSessionCallback);

    const completeCallback = shouldUseHostedCompletion
      ? (async () => {
          let authorizationHeader: string | undefined;
          if (isGuestChatboxSessionCallback) {
            const guestBearerToken = await getGuestBearerToken();
            if (!guestBearerToken) {
              return {
                success: false,
                error:
                  "Your guest session expired. Reopen the swarm link and try again.",
              };
            }
            authorizationHeader = `Bearer ${guestBearerToken}`;
          } else if (workOsUser) {
            // On chatbox routes, `useApiContext` is disabled (App.tsx
            // `enabled: !isHostedChatRoute`), so the module-level apiContext
            // is EMPTY_CONTEXT. authFetch's default header resolver then sees
            // `!apiContext.isAuthenticated && !apiContext.hasSession`, decides
            // the actor is a guest, and attaches a guest bearer — even though
            // the user is WorkOS-signed-in. The backend then materializes a
            // fresh anonymous user and 403s on chatboxAccess lookup. Explicitly
            // attach the WorkOS bearer here so the chatbox-route gating of
            // apiContext cannot demote a signed-in user to a guest.
            try {
              const accessToken = await getAccessToken();
              if (accessToken) {
                authorizationHeader = `Bearer ${accessToken}`;
              }
            } catch {
              // Fall through to authFetch default. The callback will retry
              // via the standard error UI if this token fetch fails.
            }
          }

          return completeHostedOAuthCallback(callbackContext, code, {
            callbackState: state,
            onTraceUpdate: handleLiveOAuthTrace,
            authorizationHeader,
          });
        })()
      : handleOAuthCallback(code, {
          onTraceUpdate: handleLiveOAuthTrace,
        });

    completeCallback
      .then((result) => {
        if (result.success) {
          finalizeHostedOAuth(null);
          return;
        }

        finalizeHostedOAuth(
          sanitizeHostedOAuthErrorMessage(
            result.error,
            "Authorization could not be completed. Try again."
          )
        );
      })
      .catch((callbackError) => {
        finalizeHostedOAuth(
          sanitizeHostedOAuthErrorMessage(
            callbackError,
            "Authorization could not be completed. Try again."
          )
        );
      })
      .finally(() => {
        if (!cancelled) setHostedOAuthHandling(false);
      });

    return () => {
      cancelled = true;
    };
  }, [isAuthLoading, isAuthenticated, workOsUser, getAccessToken]);

  usePostHogIdentify();

  const lastLaunchedActorRef = useRef<string | null>(null);
  useEffect(() => {
    if (!actorKey) return;
    if (lastLaunchedActorRef.current === actorKey) return;
    lastLaunchedActorRef.current = actorKey;
    posthog.capture("app_launched", {
      platform: detectPlatform(),
      environment: detectEnvironment(),
      user_agent: navigator.userAgent,
      version: __APP_VERSION__,
      is_authenticated: Boolean(workOsUser),
    });
  }, [actorKey, workOsUser, posthog]);

  // Set the initial theme mode and preset on page load
  const initialThemeMode = getInitialThemeMode();
  const initialThemePreset: ThemePreset = getInitialThemePreset();
  useEffect(() => {
    updateThemeMode(initialThemeMode);
    updateThemePreset(initialThemePreset);
  }, []);

  // Set up Electron OAuth callback handling
  useElectronOAuth();

  const isDebugCallback = window.location.pathname.startsWith(
    "/oauth/callback/debug"
  );
  const isOAuthCallback = window.location.pathname === "/callback";
  const electronMcpCallbackUrl = buildElectronMcpCallbackUrl();

  useEffect(() => {
    if (!isOAuthCallback) {
      setCallbackCompleted(false);
      setCallbackRecoveryExpired(false);
      return;
    }

    // `/callback` without auth params after auth settled is a dead-end state.
    // Return to the shell so the user can start a fresh sign-in without
    // discarding the intended post-login destination.
    if (
      !window.location.search &&
      !isWorkOsLoading &&
      !workOsUser &&
      !isAuthLoading &&
      !isAuthenticated
    ) {
      clearHostedCallbackRetryState();
      window.history.replaceState({}, "", "/");
      setCallbackCompleted(true);
      setCallbackRecoveryExpired(false);
      return;
    }

    // Let AuthKit + Convex auth settle before leaving /callback.
    if (!isAuthLoading && isAuthenticated) {
      const chatboxReturnPath = readChatboxSignInReturnPath();
      const persistedCheckoutIntent = readPersistedCheckoutIntent();
      const billingReturnPath = persistedCheckoutIntent
        ? readBillingSignInReturnPath()
        : null;
      const cliReturnPath = readCliSignInReturnPath();
      const apiKeysReturnPath = readApiKeysSignInReturnPath();
      clearChatboxSignInReturnPath();
      clearBillingSignInReturnPath();
      clearCliSignInReturnPath();
      clearApiKeysSignInReturnPath();
      window.history.replaceState(
        {},
        "",
        chatboxReturnPath ??
          billingReturnPath ??
          cliReturnPath ??
          apiKeysReturnPath ??
          "/"
      );
      setCallbackCompleted(true);
      setCallbackRecoveryExpired(false);
      return;
    }

    const timeout = setTimeout(() => {
      setCallbackRecoveryExpired(true);
    }, 15000);

    return () => clearTimeout(timeout);
  }, [
    isOAuthCallback,
    isAuthLoading,
    isAuthenticated,
    isWorkOsLoading,
    workOsUser,
  ]);

  const handleRetryCallbackSignIn = useCallback(() => {
    clearHostedCallbackRetryState();
    window.history.replaceState({}, "", "/");
    setCallbackCompleted(true);
    setCallbackRecoveryExpired(false);
    queueMicrotask(() => {
      signIn();
    });
  }, [signIn]);

  const handleReloadFromCallback = useCallback(() => {
    clearHostedCallbackRetryState();
    window.location.assign("/");
  }, []);

  const {
    appState,
    isLoading,
    isLoadingRemoteProjects,
    areServersHydrated,
    projectServers,
    displayServerConfigs,
    connectedOrConnectingServerConfigs,
    selectedMCPConfig,
    selectedServerEntry,
    isSelectedServerSyncing,
    handleConnect,
    handleDisconnect,
    handleRuntimeDisconnect,
    handleReconnect,
    reconnectServerForClientSwitch,
    ensureServersReady,
    syncAgentStatus,
    handleUpdate,
    handleRemoveServer,
    setSelectedServer,
    setSelectedMCPConfigs,
    toggleServerSelection,
    projects,
    activeProjectId,
    handleSwitchProject,
    handleCreateProject,
    handleLeaveProject,
    handleUpdateProject,
    handleUpdateHostContext,
    handleDeleteProject,
    handleProjectShared,
    saveServerConfigWithoutConnecting,
    handleConnectWithTokensFromOAuthFlow,
    handleRefreshTokensFromOAuthFlow,
    activeOrganizationId,
    setActiveOrganizationId,
    clearConvexActiveProjectSelection,
    clearLocalFallbackProjectSelection,
    pendingDashboardOAuth,
    isCloudSyncActive,
    persistRuntimeServerToProjectIfNeeded,
    activeMcpProfile,
    activeHost,
    activeHostId,
    setActiveHostId,
  } = useAppState({
    currentUserId: workOsUser?.id ?? null,
    currentActorKey: actorKey,
    hasOrganizations: effectiveOrganizations.length > 0,
    isLoadingOrganizations,
    validOrganizations: effectiveOrganizations,
    routeOrganizationId: hasRouteOrganization ? routeOrganizationId : undefined,
    requestSignIn: () => {
      void signIn();
    },
  });
  // Keep this explicit sign-out cleanup even though useAppState also cleans up
  // on auth-scope changes: WorkOS navigation can redirect before that effect
  // gets a chance to run.
  const disconnectRuntimeServersForAuthExit = useCallback(async () => {
    const serverNames = Object.keys(appState.servers);
    const cleanupPromise = Promise.allSettled([
      Promise.allSettled(
        serverNames.map((serverName) => handleDisconnect(serverName))
      ),
      disconnectAllRuntimeServers(),
    ]);
    let timeoutId: number | undefined;
    const timeoutPromise = new Promise<void>((resolve) => {
      timeoutId = window.setTimeout(
        resolve,
        AUTH_EXIT_RUNTIME_CLEANUP_TIMEOUT_MS
      );
    });

    try {
      await Promise.race([cleanupPromise, timeoutPromise]);
    } finally {
      if (timeoutId !== undefined) {
        window.clearTimeout(timeoutId);
      }
    }
  }, [appState.servers, handleDisconnect]);
  useInspectorCommandBus();
  // One-time migration from legacy localStorage state to Convex. No-op in
  // hosted mode and after the first successful run; safe to keep in the tree.
  useLocalStateMigration({
    isAuthenticated,
    isUserBootstrapping: isAuthenticated && !isUserReady,
    organizationId: activeOrganizationId,
  });
  usePostHogOrgContext(activeOrganizationId);
  const oauthDebuggerServersRef = useRef(appState.servers);
  oauthDebuggerServersRef.current = appState.servers;
  const projectServersRef = useRef(projectServers);
  projectServersRef.current = projectServers;
  const selectedServerRef = useRef(appState.selectedServer);
  selectedServerRef.current = appState.selectedServer;
  const persistRuntimeServerToProjectRef = useRef(
    persistRuntimeServerToProjectIfNeeded
  );
  persistRuntimeServerToProjectRef.current =
    persistRuntimeServerToProjectIfNeeded;
  const getInspectorServerState = useCallback((serverName: string) => {
    const runtimeServer = oauthDebuggerServersRef.current[serverName];
    const projectServer = projectServersRef.current[serverName];
    const server = runtimeServer ?? projectServer;
    return server ? { runtimeServer, projectServer, server } : null;
  }, []);
  useEffect(() => {
    return subscribeToOAuthDebuggerRequests(({ serverName }) => {
      const matchedServerName = Object.entries(
        oauthDebuggerServersRef.current
      ).find(
        ([name, server]) => name === serverName || server.name === serverName
      )?.[0];

      if (
        matchedServerName &&
        matchedServerName !== selectedServerRef.current
      ) {
        setSelectedServer(matchedServerName);
      }
    });
  }, [setSelectedServer]);
  const activeOrganizationName = effectiveOrganizations.find(
    (org) => org._id === activeOrganizationId
  )?.name;
  const hostedShellGateState = resolveHostedShellGateState({
    hostedMode: HOSTED_MODE,
    nonProdLockdown: NON_PROD_LOCKDOWN,
    isConvexAuthLoading: isAuthLoading,
    isConvexAuthenticated: isAuthenticated,
    isWorkOsLoading,
    hasWorkOsUser: !!workOsUser,
    workOsUserEmail: workOsUser?.email ?? null,
  });
  const baseHostedShellGateState = hostedShellGateState;
  const pendingDashboardOAuthServer = pendingDashboardOAuth
    ? projectServers[pendingDashboardOAuth.serverName]
    : null;
  const shouldShowPendingDashboardOAuthGate =
    !!pendingDashboardOAuth &&
    !pendingDashboardOAuthServer &&
    baseHostedShellGateState !== "logged-out" &&
    baseHostedShellGateState !== "restricted";
  const effectiveHostedShellGateState = shouldShowPendingDashboardOAuthGate
    ? "project-loading"
    : baseHostedShellGateState;
  const pendingDashboardOAuthMessage = pendingDashboardOAuth
    ? `Finishing OAuth sign-in for ${pendingDashboardOAuth.serverName}...`
    : undefined;
  const hasAnyFirstRunBlockingProjectServers = Object.keys(projectServers).some(
    (serverName) => serverName !== EXCALIDRAW_SERVER_NAME
  );
  const remoteFirstRunOnboardingShown =
    currentUser == null
      ? undefined
      : currentUser.hasSeenOnboarding === true ||
        currentUser.hasCompletedOnboarding === true;
  const hasSeenFirstRunOnboarding = remoteFirstRunOnboardingShown === true;
  // A signed-in user counts as "new" (and thus gets the first-run Playground
  // redirect) only when their account was created on/after the rollout cutoff.
  // This keeps every pre-existing account on Home even if its onboarding flag
  // was never set, while still sending brand-new signups to Playground.
  const isNewSignedInAccount =
    !!workOsUser &&
    currentUser?.isAnonymous !== true &&
    typeof currentUser?.createdAt === "number" &&
    currentUser.createdAt >= FIRST_RUN_PLAYGROUND_ROLLOUT_MS;
  const isHostedDefaultRoute =
    activeTab === "home" || activeTab === "servers" || activeTab === "clients";
  const shouldHoldHostedDefaultRouteForAuth =
    HOSTED_MODE &&
    !isHostedChatRoute &&
    isHostedDefaultRoute &&
    hostedShellGateState === "auth-loading";
  const shouldHoldHostedHomeRouteForAppReady =
    HOSTED_MODE &&
    !isHostedChatRoute &&
    activeTab === "home" &&
    effectiveHostedShellGateState === "ready" &&
    (isAuthLoading ||
      !isAuthenticated ||
      isLoadingRemoteProjects ||
      !areServersHydrated ||
      !activeProjectId ||
      activeProjectId === "none");
  const shouldRouteToFirstRunOnboarding =
    !isHostedChatRoute &&
    !isBareCompareRoute &&
    !isWorkOsLoading &&
    effectiveHostedShellGateState === "ready" &&
    !(isAuthenticated && currentUser === undefined) &&
    !hasSeenFirstRunOnboarding &&
    (!HOSTED_MODE ||
      (isAuthenticated &&
        !isLoadingRemoteProjects &&
        areServersHydrated &&
        !!activeProjectId &&
        activeProjectId !== "none")) &&
    isFirstRunEligible(
      hasAnyFirstRunBlockingProjectServers,
      activeTab,
      !!workOsUser,
      remoteFirstRunOnboardingShown,
      isNewSignedInAccount
    );
  const shouldHoldHostedHomeRouteForFirstRunRedirect =
    HOSTED_MODE && activeTab === "home" && shouldRouteToFirstRunOnboarding;

  const previousConnectedServersRef = useRef<Set<string> | null>(null);
  useEffect(() => {
    const connectedServers = new Set(
      Object.entries<ServerWithName>(appState.servers)
        .filter(([, server]) => server.connectionStatus === "connected")
        .map(([name]) => name)
    );

    const previousConnectedServers = previousConnectedServersRef.current;
    const newlyConnectedServers = getNewlyConnectedServers(
      previousConnectedServers,
      connectedServers
    );

    if (activeTab === "servers" || activeTab === "clients") {
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
            "true"
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
      activeTab === "playground" ||
      activeTab === "tools" ||
      activeTab === "resources" ||
      activeTab === "prompts" ||
      activeTab === "tasks" ||
      activeTab === "conformance" ||
      activeTab === "compatibility" ||
      activeTab === "auth";
    if (!needsServer || selectedMCPConfig) return;

    const firstConnected = Object.entries(projectServers).find(
      ([, server]) => (server as any).connectionStatus === "connected"
    );
    if (firstConnected) {
      setSelectedServer(firstConnected[0]);
      // Playground reads `selectedMultipleServers` as the authoritative
      // selection; if we only seed `selectedServer`, the first toggle in
      // the composer popover flips the auto-selected server off because
      // the multi-set goes from `[]` → `[toggled]` and the single-server
      // fallback drops out.
      if (
        activeTab === "playground" &&
        appState.selectedMultipleServers.length === 0
      ) {
        setSelectedMCPConfigs([firstConnected[0]]);
      }
    }
  }, [
    activeTab,
    selectedMCPConfig,
    projectServers,
    setSelectedServer,
    setSelectedMCPConfigs,
    appState.selectedMultipleServers,
  ]);

  // Create effective app state that uses the correct projects (Convex when authenticated)
  const effectiveAppState = useMemo(
    () => ({
      ...appState,
      projects,
      activeProjectId,
    }),
    [appState, projects, activeProjectId]
  );

  // Get the Convex project ID from the active project
  const activeProject = projects[activeProjectId];
  const isClientConfigSyncPending =
    useProjectClientConfigSyncPending(activeProjectId);
  // Fallback chain: active named host (top-bar selection or project default
  // resolved inside useAppState) → project clientConfig shadow → SDK defaults.
  // The host is the authoritative source once `activeHost` hydrates; the
  // shadow path only matters during the bootstrap window before
  // `hostConfigsV2:getProjectDefault` returns.
  const hostedClientCapabilities = (activeHost?.clientCapabilities ??
    getEffectiveProjectClientCapabilities(activeProject?.clientConfig) ??
    getDefaultClientCapabilities()) as Record<string, unknown>;
  const convexProjectId = activeProject?.sharedProjectId ?? null;
  const projectServerConfigDto = useQuery(
    "projectServerConfig:getConfig" as never,
    convexProjectId ? ({ projectId: convexProjectId } as never) : "skip"
  ) as ProjectServerConfigDto | null | undefined;
  const isProjectServerConfigLoading =
    Boolean(convexProjectId) && projectServerConfigDto === undefined;
  // hostsTabSelectedHostId is a Hosts-tab-local cursor; drop it when scope
  // changes so it can't bleed across projects. `activeHostId` is owned by
  // useAppState (project-keyed in localStorage) and self-resets.
  useEffect(() => {
    if (!isAuthenticated || !convexProjectId) {
      setHostsTabSelectedHostId(null);
    }
  }, [isAuthenticated, convexProjectId]);
  useEffect(() => {
    setHostsTabSelectedHostId(null);
  }, [convexProjectId]);
  const routeScopedOrganizationId = hasRouteOrganization
    ? routeOrganizationId ?? null
    : null;
  const rawBillingOrganizationId =
    routeScopedOrganizationId ??
    activeOrganizationId ??
    activeProject?.organizationId ??
    null;
  const billingOrganizationId =
    !isLoadingOrganizations &&
    rawBillingOrganizationId &&
    effectiveOrganizations.some((org) => org._id === rawBillingOrganizationId)
      ? rawBillingOrganizationId
      : null;
  const activeProjectBillingOrganizationId =
    activeProject?.organizationId &&
    billingOrganizationId &&
    activeProject.organizationId === billingOrganizationId
      ? billingOrganizationId
      : null;
  const isBillingContextPending =
    isAuthenticated &&
    isLoadingOrganizations &&
    !!(
      routeOrganizationId ||
      activeOrganizationId ||
      activeProject?.organizationId ||
      convexProjectId
    );
  const billingProjectId =
    isCloudSyncActive &&
    !isBillingContextPending &&
    activeProject &&
    convexProjectId &&
    activeProjectBillingOrganizationId
      ? convexProjectId
      : null;
  const {
    billingStatus: shellBillingStatus,
    organizationPremiumness,
    projectPremiumness,
    selectFreeAfterTrial,
    isSelectingFreeAfterTrial,
  } = useOrganizationBilling(isAuthenticated ? billingOrganizationId : null, {
    projectId: billingProjectId,
  });
  const billingUiEnabled = billingEntitlementsUiEnabled === true;
  const navPremiumness =
    billingProjectId && projectPremiumness
      ? projectPremiumness
      : organizationPremiumness;
  const activeTabGate = getPremiumnessGateForTab(activeTab);
  const activeTabBillingLocked = isPremiumnessGateDeniedForShell({
    billingUiEnabled,
    projectPremiumness,
    organizationPremiumness,
    hasProject: !!billingProjectId,
    gateKey: activeTabGate,
  });
  const activeTabBillingFeature = getRequiredBillingFeatureForTab(activeTab);
  const upgradePlanForActiveTab = getUpgradePlanForDeniedGate(
    navPremiumness,
    activeTabGate
  );
  const projectCreationGate = resolveBillingGateState({
    billingUiEnabled,
    organizationId: billingOrganizationId,
    billingStatus: shellBillingStatus,
    premiumness: organizationPremiumness,
    gate: BILLING_GATES.projectCreation,
  });
  const sidebarGateDenied = useMemo(() => {
    const denied: Partial<Record<BillingFeatureName, boolean>> = {};
    for (const key of ["evals", "chatboxes", "cicd"] as const) {
      denied[key] = isGateAccessDenied(navPremiumness, key);
    }
    return denied;
  }, [navPremiumness]);
  const billingGateEnforcementActive =
    billingUiEnabled && isBillingEnforcementActive(navPremiumness);
  const isGuestProjectActor = currentUser?.isAnonymous === true;
  const guestProjectLimitReached =
    isGuestProjectActor && Object.keys(projects).length >= 1;
  const noOrganizationsAvailable =
    isAuthenticated &&
    !isLoadingOrganizations &&
    effectiveOrganizations.length === 0;
  const activeOrgMyRole = activeOrganizationId
    ? effectiveOrganizations.find((org) => org._id === activeOrganizationId)
        ?.myRole
    : undefined;
  const insufficientOrgRoleForCreate =
    isAuthenticated &&
    !!activeOrganizationId &&
    activeOrgMyRole !== undefined &&
    activeOrgMyRole !== "owner" &&
    activeOrgMyRole !== "admin" &&
    activeOrgMyRole !== "member";
  const isCreateProjectDisabled =
    projectCreationGate.isDenied ||
    guestProjectLimitReached ||
    noOrganizationsAvailable ||
    insufficientOrgRoleForCreate;
  const createProjectDisabledReason = guestProjectLimitReached
    ? "Sign in to create more projects"
    : noOrganizationsAvailable
    ? "Create or join an organization to create projects"
    : insufficientOrgRoleForCreate
    ? "You don't have permission to create projects"
    : projectCreationGate.denialMessage ?? undefined;
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

  useEffect(() => {
    const hasStaleCloudProjectSelection =
      isCloudSyncActive &&
      !isLoadingOrganizations &&
      !isLoadingRemoteProjects &&
      activeProjectId !== "none" &&
      (!!convexProjectId || !activeProject) &&
      !billingProjectId;

    if (!hasStaleCloudProjectSelection) {
      return;
    }

    clearConvexActiveProjectSelection();
  }, [
    activeProject,
    activeProjectId,
    billingProjectId,
    clearConvexActiveProjectSelection,
    convexProjectId,
    isCloudSyncActive,
    isLoadingOrganizations,
    isLoadingRemoteProjects,
  ]);

  // Fetch views for the project to determine which servers have saved views
  const { viewsByServer } = useViewQueries({
    isAuthenticated,
    projectId: convexProjectId,
  });

  // Fetch project servers to map server IDs to names
  const { serversById } = useProjectServers({
    isAuthenticated,
    projectId: convexProjectId,
  });
  const hostedServerIdsByName = useMemo(
    () =>
      Object.fromEntries(
        Array.from(serversById.entries()).map(([id, name]) => [name, id])
      ),
    [serversById]
  );
  const oauthTokensByServerId = useMemo(
    () =>
      buildOAuthTokensByServerId(
        Object.keys(hostedServerIdsByName),
        (name) => hostedServerIdsByName[name],
        (name) => appState.servers[name]?.oauthTokens?.access_token
      ),
    [hostedServerIdsByName, appState.servers]
  );
  const hostedMcpProfilePins = useMemo(() => {
    const rawClientInfo = activeMcpProfile?.initialize?.clientInfo;
    const clientInfo =
      rawClientInfo &&
      typeof rawClientInfo === "object" &&
      !Array.isArray(rawClientInfo)
        ? rawClientInfo
        : undefined;

    const rawSupportedVersions =
      activeMcpProfile?.initialize?.supportedProtocolVersions;
    const supportedProtocolVersions =
      Array.isArray(rawSupportedVersions) && rawSupportedVersions.length > 0
        ? rawSupportedVersions.filter(
            (v): v is string => typeof v === "string" && v.trim() !== ""
          )
        : undefined;

    const rawHostPin = activeMcpProfile?.mcpProtocolVersion;
    const hostPin: McpProtocolVersion | undefined =
      typeof rawHostPin === "string" && isKnownProtocolVersion(rawHostPin)
        ? rawHostPin
        : undefined;

    const mcpProtocolVersionsByServerId: Record<string, McpProtocolVersion> =
      {};
    for (const serverId of new Set(Object.values(hostedServerIdsByName))) {
      // Project-server config is the control-plane source for per-server
      // protocol overrides. Host config mirrors it through Convex fan-out,
      // but hosted API calls should not fall back to the host default while
      // that reactive host snapshot is still catching up.
      const rawServerOverride =
        projectServerConfigDto?.overrides?.[serverId]
          ?.mcpProtocolVersionOverride ??
        activeHost?.serverConnectionOverrides?.[serverId]
          ?.mcpProtocolVersionOverride;
      const serverOverride: McpProtocolVersion | undefined =
        typeof rawServerOverride === "string" &&
        isKnownProtocolVersion(rawServerOverride)
          ? rawServerOverride
          : undefined;
      const effective = resolveEffectiveMcpProtocolVersion(
        serverOverride,
        hostPin
      );
      if (!effective) continue;
      mcpProtocolVersionsByServerId[serverId] = effective;
    }

    return {
      clientInfo,
      supportedProtocolVersions,
      mcpProtocolVersionsByServerId:
        Object.keys(mcpProtocolVersionsByServerId).length > 0
          ? mcpProtocolVersionsByServerId
          : undefined,
    };
  }, [
    activeHost?.serverConnectionOverrides,
    activeMcpProfile,
    hostedServerIdsByName,
    projectServerConfigDto?.overrides,
  ]);
  useApiContext({
    projectId: convexProjectId,
    serverIdsByName: hostedServerIdsByName,
    clientCapabilities: hostedClientCapabilities,
    clientInfo: hostedMcpProfilePins.clientInfo,
    supportedProtocolVersions: hostedMcpProfilePins.supportedProtocolVersions,
    mcpProtocolVersionsByServerId:
      hostedMcpProfilePins.mcpProtocolVersionsByServerId,
    clientConfigSyncPending:
      isClientConfigSyncPending || isProjectServerConfigLoading,
    getAccessToken,
    oauthTokensByServerId,
    // `ApiContext.isAuthenticated` means "WorkOS user is signed in",
    // not "Convex is authenticated". Convex reports authenticated for guest
    // sessions too (because `useUnifiedConvexAuth` returns a placeholder user
    // to satisfy the provider), so passing the Convex flag here makes the
    // guest-bearer fallback in `getApiAuthorizationHeader` think a real
    // user is signed in and return null. The WorkOS user object is the
    // correct signal.
    isAuthenticated: !!workOsUser,
    hasSession: !!workOsUser || isWorkOsLoading,
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

  const navigateToTarget = useCallback(
    (target: string, options?: { replace?: boolean }) => {
      navigateApp(navigationTargetToPath(target), options);
    },
    []
  );
  const navigateToServers = useCallback(
    (options?: { replace?: boolean }) => {
      if (window.location.pathname === routePaths.servers) {
        return;
      }
      navigateToTarget(routePaths.servers, options);
    },
    [navigateToTarget]
  );

  useEffect(() => {
    if (!routeOrganizationId || !hasRouteOrganization) {
      return;
    }
    if (activeOrganizationId !== routeOrganizationId) {
      setActiveOrganizationId(routeOrganizationId);
    }
  }, [
    activeOrganizationId,
    hasRouteOrganization,
    routeOrganizationId,
    setActiveOrganizationId,
  ]);

  useEffect(() => {
    if (!HOSTED_MODE || isHostedHashTabAllowed(activeTab)) {
      return;
    }
    toast.error(`${activeTab} is not available in hosted mode.`);
    setActiveOrganizationId(undefined);
    if (window.location.pathname !== routePaths.servers) {
      navigateApp(routePaths.servers, { replace: true });
    }
  }, [activeTab, setActiveOrganizationId]);

  useLayoutEffect(() => {
    if (HOSTED_MODE) {
      return;
    }

    const unregisterNavigate = registerInspectorCommandHandler(
      "navigate",
      async (rawCommand) => {
        const command = rawCommand as NavigateInspectorCommand;
        const path = navigationTargetToPath(command.payload.target);

        navigateApp(path);
        await waitForUiCommit();

        return { activeTab: pathnameToActiveTab(path) };
      }
    );

    const unregisterSelectServer = registerInspectorCommandHandler(
      "selectServer",
      async (rawCommand) => {
        const command = rawCommand as SelectServerInspectorCommand;
        let serverState = getInspectorServerState(command.payload.serverName);
        if (!serverState) {
          await syncAgentStatus();
          await waitForUiCommit();
          serverState = getInspectorServerState(command.payload.serverName);
        }

        if (!serverState) {
          throw createInspectorCommandClientError(
            "unknown_server",
            `Unknown server "${command.payload.serverName}".`
          );
        }

        const connectionStatus =
          serverState.runtimeServer?.connectionStatus ??
          serverState.projectServer?.connectionStatus ??
          "disconnected";
        if (connectionStatus !== "connected") {
          throw createInspectorCommandClientError(
            "disconnected_server",
            `Server "${command.payload.serverName}" is ${connectionStatus}.`
          );
        }

        setSelectedServer(command.payload.serverName);
        await waitForUiCommit();

        return {
          selectedServer: command.payload.serverName,
          connectionStatus,
        };
      }
    );

    const unregisterOpenPlayground = registerInspectorCommandHandler(
      "openPlayground",
      async (rawCommand) => {
        const command = rawCommand as OpenPlaygroundInspectorCommand;

        if (command.payload.serverName) {
          let serverState = getInspectorServerState(command.payload.serverName);
          if (!serverState) {
            await syncAgentStatus();
            await waitForUiCommit();
            serverState = getInspectorServerState(command.payload.serverName);
          }

          if (!serverState) {
            throw createInspectorCommandClientError(
              "unknown_server",
              `Unknown server "${command.payload.serverName}".`
            );
          }

          setSelectedServer(command.payload.serverName);
          // Playground reads `selectedMultipleServers` as the authoritative
          // selection whenever it is non-empty (see PlaygroundMain /
          // PlaygroundTab). If we only set `selectedServer`, an external
          // `openPlayground` command targeting server C while the user
          // already has `[A, B]` selected lands on Playground with the
          // header focused on C but tools/LLM still scoped to A+B; and
          // the `needsServer` auto-select effect can't rescue it because
          // `selectedMCPConfig` is now set, so it early-returns. The
          // command's intent is "focus Playground on this server", so
          // replace the multi-set rather than merging.
          setSelectedMCPConfigs([command.payload.serverName]);
          const runtimeForPersist = serverState.runtimeServer;
          if (runtimeForPersist?.connectionStatus === "connected") {
            void persistRuntimeServerToProjectRef.current(
              command.payload.serverName,
              runtimeForPersist
            );
          }
        }

        navigateApp(routePaths.playground);
        await waitForUiCommit();

        return {
          activeTab: "playground",
          selectedServer:
            command.payload.serverName || selectedServerRef.current || "none",
        };
      }
    );

    return () => {
      unregisterNavigate();
      unregisterSelectServer();
      unregisterOpenPlayground();
    };
  }, [
    getInspectorServerState,
    setSelectedServer,
    setSelectedMCPConfigs,
    syncAgentStatus,
  ]);

  useLayoutEffect(() => {
    if (shouldRouteToFirstRunOnboarding) {
      navigateApp(routePaths.playground);
    }
  }, [shouldRouteToFirstRunOnboarding]);

  // When the active project changes (org switch, project delete, manual switch),
  // snap to Servers — staying on App Builder/Chat would leave the user pointed
  // at a project that no longer exists. Start tracking only after auth/project
  // loading settles so the initial local-default → Convex-project hydration
  // doesn't yank deep-links away on first load.
  const previousActiveProjectIdRef = useRef<string | null>(null);
  useEffect(() => {
    if (isLoadingRemoteProjects || isAuthLoading || isWorkOsLoading) {
      return;
    }

    const previousActiveProjectId = previousActiveProjectIdRef.current;
    previousActiveProjectIdRef.current = activeProjectId;
    if (
      previousActiveProjectId == null ||
      previousActiveProjectId === activeProjectId ||
      previousActiveProjectId === "none" ||
      activeProjectId === "none"
    ) {
      return;
    }
    navigateToServers();
  }, [
    activeProjectId,
    isAuthLoading,
    isLoadingRemoteProjects,
    isWorkOsLoading,
    navigateToServers,
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

  // `/billing?plan=&interval=` → auth (if needed) → org billing path → auto-checkout when intent is valid.
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

      if (path !== routePaths.root && path !== "") {
        navigateApp(routePaths.root, { replace: true });
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

    const projectOrgId = activeProject?.organizationId;
    const orgId = resolveCheckoutOrganizationId(
      effectiveOrganizations,
      activeOrganizationId,
      projectOrgId
    );

    if (!orgId) {
      toast.error("Create or join an organization to continue with checkout.");
      consumeCheckoutIntent();
      return;
    }

    if (
      routeOrganizationId === orgId &&
      routeOrganizationSection === "billing"
    ) {
      return;
    }

    if (billingDeepLinkNavRef.current) {
      return;
    }

    navigateApp(buildOrganizationPath(orgId, "billing"));
    billingDeepLinkNavRef.current = true;
  }, [
    activeOrganizationId,
    activeProject?.organizationId,
    billingEntitlementsUiEnabled,
    consumeCheckoutIntent,
    isAuthLoading,
    isAuthenticated,
    isDebugCallback,
    isHostedChatRoute,
    isLoadingOrganizations,
    pendingCheckoutIntent,
    routeOrganizationId,
    routeOrganizationSection,
    signIn,
    effectiveOrganizations,
    workOsUser?.id,
  ]);

  useEffect(() => {
    if (activeTab === "ci-evals") {
      if (!evaluateRunsFlagsLoaded) {
        return;
      }

      if (evaluateRunsEnabled !== true) {
        navigateApp(buildEvalsPath({ type: "list" }), { replace: true });
        return;
      }
    }

    if (
      activeTabBillingLocked &&
      activeTabBillingFeature &&
      activeTab !== "chatboxes"
    ) {
      toast.error(
        `${formatBillingFeatureName(
          activeTabBillingFeature
        )} is not included in the ${formatPlanName(
          shellBillingStatus?.plan
        )} plan. Upgrade the organization to continue.`
      );
      navigateToTarget(defaultHubRoute, { replace: true });
    } else if (activeTab === "clients" && !isAuthenticated) {
      navigateToTarget(defaultHubRoute, { replace: true });
    } else if (activeTab === "registry" && registryEnabled !== true) {
      navigateToTarget(defaultHubRoute, { replace: true });
    } else if (
      activeTab === "learning" &&
      (learningEnabled !== true || !isAuthenticated)
    ) {
      navigateToTarget(defaultHubRoute, { replace: true });
    } else if (activeTab === "client-config") {
      navigateToTarget(defaultHubRoute, { replace: true });
    } else if (activeTab === "conformance" && conformanceEnabled !== true) {
      navigateToTarget(defaultHubRoute, { replace: true });
    } else if (
      activeTab === "compatibility" &&
      compatibilityEnabled === false
    ) {
      // Only bounce on an explicit `false`. While PostHog hydrates the flag is
      // `undefined`; redirecting then would strand a flagged-in user who
      // cold-loads /compatibility (the redirect fires before the flag
      // resolves) — the "refresh sends me home" bug. Mirrors the xaa branch.
      navigateToTarget(defaultHubRoute, { replace: true });
    } else if (activeTab === "xaa-flow" && xaaEnabled === false) {
      // Only bounce on an explicit `false`. While PostHog hydrates the flag is
      // `undefined`; redirecting then would strand a flagged-in user who
      // cold-loads /xaa-flow (the redirect fires before the flag resolves) —
      // which is exactly the "refresh sends me home" bug. Mirrors ComputerRoute.
      navigateToTarget(defaultHubRoute, { replace: true });
    }
  }, [
    conformanceEnabled,
    compatibilityEnabled,
    defaultHubRoute,
    registryEnabled,
    learningEnabled,
    evaluateRunsFlagsLoaded,
    evaluateRunsEnabled,
    xaaEnabled,
    isAuthenticated,
    activeTab,
    navigateToTarget,
  ]);

  const handleNavigate = (section: string) => {
    navigateToTarget(section);
  };

  const handleSidebarSwitchOrganization = useCallback(
    (
      organizationId: string,
      section: OrganizationRouteSection = "overview"
    ) => {
      setActiveOrganizationId(organizationId);
      navigateApp(buildOrganizationPath(organizationId, section));
    },
    [setActiveOrganizationId]
  );

  const handleSwitchActiveOrganization = useCallback(
    (organizationId: string) => {
      if (organizationId === activeOrganizationId) return;
      // Mirror main's `handleSidebarSwitchOrganization`: only flip the active
      // org. The auto-resolution effect in `use-project-state.ts` notices that
      // the previous active project is no longer in the new org's filtered
      // project list and picks a new one; we must NOT clear local/convex project
      // selection here, otherwise the local-fallback default project (which can
      // carry servers from earlier sessions) bleeds through during the
      // transition.
      setActiveOrganizationId(organizationId);
      navigateToServers();
    },
    [activeOrganizationId, setActiveOrganizationId, navigateToServers]
  );

  const handleContinueEvalInChat = useCallback(
    (handoff: Omit<EvalChatHandoff, "id">) => {
      setSelectedMCPConfigs(handoff.serverNames);
      setEvalChatHandoff({
        ...handoff,
        id: `eval-chat-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      });
      navigateApp(routePaths.playground);
    },
    [setSelectedMCPConfigs]
  );

  useEffect(() => {
    if (!isAuthenticated) {
      return;
    }

    if (
      routeOrganizationId &&
      optimisticallyDeletedOrganizationIds.includes(routeOrganizationId)
    ) {
      return;
    }

    const navigationTarget = getInvalidOrganizationRouteNavigationTarget({
      routeTab: activeTab,
      routeOrganizationId,
      isLoadingOrganizations,
      hasRouteOrganization,
    });
    if (!navigationTarget) {
      return;
    }

    setActiveOrganizationId(undefined);
    if (navigationTarget === routePaths.servers) {
      navigateToServers({ replace: true });
    } else {
      navigateToTarget(navigationTarget, { replace: true });
    }
  }, [
    activeTab,
    hasRouteOrganization,
    isAuthenticated,
    isLoadingOrganizations,
    navigateToServers,
    navigateToTarget,
    optimisticallyDeletedOrganizationIds,
    routeOrganizationId,
    setActiveOrganizationId,
  ]);

  const handleOrganizationDeleted = useCallback(
    (deletedOrganizationId: string) => {
      setOptimisticallyDeletedOrganizationIds((currentIds) =>
        currentIds.includes(deletedOrganizationId)
          ? currentIds
          : [...currentIds, deletedOrganizationId]
      );

      const remainingOrganizations = effectiveOrganizations.filter(
        (organization) => organization._id !== deletedOrganizationId
      );
      const fallbackOrganizationId = resolveDeletedOrganizationFallbackId(
        remainingOrganizations
      );
      const isDeletedCurrentOrganization =
        activeOrganizationId === deletedOrganizationId ||
        routeOrganizationId === deletedOrganizationId ||
        activeProject?.organizationId === deletedOrganizationId;

      clearLocalFallbackProjectSelection(
        deletedOrganizationId,
        fallbackOrganizationId
      );

      if (
        isDeletedCurrentOrganization &&
        (activeProject?.organizationId === deletedOrganizationId ||
          !fallbackOrganizationId)
      ) {
        clearConvexActiveProjectSelection();
      }

      if (!isDeletedCurrentOrganization) {
        return;
      }

      setActiveOrganizationId(fallbackOrganizationId);
      navigateToServers();
    },
    [
      activeOrganizationId,
      activeProject?.organizationId,
      clearLocalFallbackProjectSelection,
      clearConvexActiveProjectSelection,
      effectiveOrganizations,
      navigateToServers,
      routeOrganizationId,
      setActiveOrganizationId,
    ]
  );

  const handleSidebarSwitchProject = useCallback(
    async (projectId: string) => {
      const nextProject = projects[projectId];
      await handleSwitchProject(projectId);

      const navigationTarget = getProjectSwitchNavigationTarget({
        activeTab,
        activeOrganizationId,
        nextProjectOrganizationId: nextProject?.organizationId,
      });
      if (navigationTarget) {
        navigateToTarget(navigationTarget);
      }
    },
    [
      activeOrganizationId,
      activeTab,
      handleSwitchProject,
      navigateToTarget,
      projects,
    ]
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
        !routeOrganizationId ||
        routeOrganizationSection !== "billing" ||
        !pendingCheckoutIntent
      ) {
        return null;
      }
      return {
        plan: pendingCheckoutIntent.plan,
        interval: pendingCheckoutIntent.interval,
        organizationId: routeOrganizationId,
      };
    }, [
      billingUiEnabled,
      activeTab,
      routeOrganizationId,
      routeOrganizationSection,
      pendingCheckoutIntent?.interval,
      pendingCheckoutIntent?.plan,
    ]);

  const playgroundServerSelectorProps = useMemo(():
    | PlaygroundServerSelectorProps
    | undefined => {
    if (activeTab !== "playground") return undefined;
    return {
      serverConfigs: displayServerConfigs,
      selectedServer: appState.selectedServer,
      selectedMultipleServers: appState.selectedMultipleServers,
      // Playground supports multi-server selection — the user can toggle
      // several servers on simultaneously, the chat session sees their union,
      // and the docked tools pane aggregates tools across all of them.
      isMultiSelectEnabled: true,
      onServerChange: setSelectedServer,
      onMultiServerToggle: toggleServerSelection,
      onSelectMultipleServers: setSelectedMCPConfigs,
      onConnect: handleConnect,
      onReconnect: handleReconnect,
      onDisconnect: handleDisconnect,
      showOnlyOAuthServers: false,
      showOnlyServersWithViews: false,
    };
  }, [
    activeTab,
    displayServerConfigs,
    appState.selectedServer,
    appState.selectedMultipleServers,
    setSelectedServer,
    toggleServerSelection,
    setSelectedMCPConfigs,
    handleConnect,
    handleReconnect,
    handleDisconnect,
  ]);

  if (isDebugCallback) {
    return <OAuthDebugCallback />;
  }

  if (electronMcpCallbackUrl) {
    return (
      <OAuthDesktopReturnNotice returnToElectronUrl={electronMcpCallbackUrl} />
    );
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
              onClick={handleRetryCallbackSignIn}
            >
              Try sign in again
            </button>
            <button
              type="button"
              className="rounded border px-4 py-2 text-sm font-medium"
              onClick={handleReloadFromCallback}
            >
              Reload
            </button>
          </div>
        </div>
      );
    }

    return <LoadingScreen />;
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

  if (
    shouldHoldHostedDefaultRouteForAuth ||
    shouldHoldHostedHomeRouteForAppReady ||
    shouldHoldHostedHomeRouteForFirstRunRedirect
  ) {
    return <LoadingScreen />;
  }

  if (
    !isHostedChatRoute &&
    isAuthenticated &&
    (currentUser === undefined || (currentUser === null && isEnsuringUser))
  ) {
    return <LoadingScreen />;
  }

  if (!isHostedChatRoute && isAuthenticated && currentUser === null) {
    return <UserSetupError />;
  }

  if (
    !isHostedChatRoute &&
    !!workOsUser &&
    isAuthenticated &&
    currentUser?.isAnonymous !== true &&
    typeof currentUser?.createdAt === "number" &&
    currentUser.createdAt >= OCCUPATION_GATE_ROLLOUT_MS &&
    !currentUser?.occupation?.trim()
  ) {
    return (
      <OccupationGate
        userId={workOsUser?.id ?? null}
        email={workOsUser?.email}
      />
    );
  }

  const shouldShowActiveServerSelector =
    activeTab === "tools" ||
    activeTab === "resources" ||
    activeTab === "prompts" ||
    activeTab === "tasks" ||
    activeTab === "conformance" ||
    activeTab === "compatibility" ||
    activeTab === "oauth-flow" ||
    (activeTab === "xaa-flow" && xaaEnabled === true) ||
    activeTab === "chat" ||
    activeTab === "views";

  const activeServerSelectorProps: ActiveServerSelectorProps | undefined =
    shouldShowActiveServerSelector
      ? {
          // Stays on projectServers (NOT displayServerConfigs): the header
          // picker also drives the OAuth Debugger / XAA tabs, and tests
          // explicitly guard against surfacing runtime-only entries there
          // (cross-project / cross-org leak prevention).
          serverConfigs: projectServers,
          selectedServer: appState.selectedServer,
          onServerChange: setSelectedServer,
          // XAA targets are saved server configs, never live connections.
          // Adding one from the header picker must NOT launch a browser OAuth
          // flow (handleConnect does a full-page redirect to the auth server,
          // which strands the user on an error page when the client isn't
          // registered). Save without connecting, then select it as the target.
          onConnect:
            activeTab === "xaa-flow" && xaaEnabled === true
              ? async (formData) => {
                  await saveServerConfigWithoutConnecting(formData);
                  const name = formData.name?.trim();
                  if (name) setSelectedServer(name);
                }
              : handleConnect,
          onReconnect: handleReconnect,
          // The XAA / OAuth debuggers add servers through their own purpose-built
          // modals (target URL + client credentials + simulated identity), not
          // the generic Add Server modal. Route the header "Add Server" click to
          // the active debugger's modal so it matches the in-canvas "Configure"
          // button; other tabs fall back to the generic modal (prop omitted).
          onAddServerRequested:
            activeTab === "xaa-flow" && xaaEnabled === true
              ? () => setXaaServerModalNonce((n) => n + 1)
              : activeTab === "oauth-flow"
              ? () => setOauthServerModalNonce((n) => n + 1)
              : undefined,
          isMultiSelectEnabled: activeTab === "chat",
          onMultiServerToggle: toggleServerSelection,
          selectedMultipleServers: appState.selectedMultipleServers,
          showOnlyOAuthServers:
            activeTab === "oauth-flow" ||
            (activeTab === "xaa-flow" && xaaEnabled === true),
          includeXaaServers: activeTab === "xaa-flow" && xaaEnabled === true,
          autoSelectFilteredServer:
            activeTab !== "oauth-flow" &&
            !(activeTab === "xaa-flow" && xaaEnabled === true),
          showOnlyServersWithViews: activeTab === "views",
          serversWithViews: serversWithViews,
          hasMessages: false,
        }
      : undefined;

  const isEvalsTab = activeTab === "evals" || activeTab === "ci-evals";
  const globalHostBarProps =
    isAuthenticated &&
    convexProjectId &&
    !isEvalsTab &&
    // The playground has its own client chip in the chat-input toolbar
    // (switch / compare / add host), so the global host bar is redundant
    // there. It stays on every other tab.
    activeTab !== "playground"
      ? {
          projectId: convexProjectId,
          onEditHost: (hostId: string) => {
            setHostsTabSelectedHostId(hostId);
            navigateApp(buildHostsPath(hostId));
          },
          // Active whenever the clients tab is mounted — the URL is the
          // source of truth for which host the canvas renders, so every
          // dropdown/cycle change must push `/clients/<hostId>`. Without
          // this, bare `/clients` (no `:hostId`) renders the cached
          // `previewedHostId` and clicking a different host only updates
          // the preview store, leaving the canvas stuck on the original.
          onCanvasReplaceHost:
            activeTab === "clients"
              ? (hostId: string) => {
                  setHostsTabSelectedHostId(hostId);
                  navigateApp(buildHostsPath(hostId), { replace: true });
                }
              : undefined,
        }
      : undefined;

  // The home route has no org segment, so its org is resolved from the active
  // project (see HomeRoute). Until auth, the db user, the org list, and the
  // project list have all settled, that org is transiently null — which must
  // read as "loading", not as the empty "no organization" state. Bounded:
  // every signal here resolves once its query/bootstrap completes.
  const isHomeContextResolving =
    isAuthLoading ||
    (isAuthenticated &&
      (isEnsuringUser ||
        !isUserReady ||
        isLoadingOrganizations ||
        isLoadingRemoteProjects));

  // Org shown on `/home`. Falls back to the active project's org (the route
  // carries none) and then validates membership against the loaded org list —
  // the same gate billing applies to `rawBillingOrganizationId` above — so a
  // stale project pointing at an org the user no longer belongs to resolves to
  // null (→ welcome CTA) instead of firing org-scoped queries that would throw.
  const rawHomeOrganizationId =
    activeOrganizationId ?? activeProject?.organizationId ?? null;
  const homeOrganizationId =
    !isLoadingOrganizations &&
    rawHomeOrganizationId &&
    effectiveOrganizations.some((org) => org._id === rawHomeOrganizationId)
      ? rawHomeOrganizationId
      : null;

  const routeContext: AppRouteContext = {
    activeMcpProfile,
    activeOrganizationId,
    activeOrganizationName,
    activeProject,
    isHomeContextResolving,
    homeOrganizationId,
    activeProjectBillingOrganizationId,
    activeProjectId,
    activeTabBillingFeature,
    activeTabBillingLocked,
    appState,
    billingOrganizationId,
    billingProjectId,
    billingUiEnabled,
    activeHost,
    activeHostId,
    checkoutIntentForBilling,
    connectedOrConnectingServerConfigs,
    consumeCheckoutIntent,
    displayServerConfigs,
    convexProjectId,
    defaultHubRoute,
    ensureServersReady,
    evalChatHandoff,
    evaluateRunsEnabled,
    evaluateRunsFlagsLoaded,
    handleCheckoutIntentNavigationStarted,
    handleConnect,
    handleConnectWithTokensFromOAuthFlow,
    handleContinueEvalInChat,
    handleDeleteProject,
    handleDisconnect,
    handleLeaveProject,
    handleNavigate,
    handleOrganizationDeleted,
    handleProjectShared,
    handleReconnect,
    handleRuntimeDisconnect,
    handleRefreshTokensFromOAuthFlow,
    handleRemoveServer,
    handleUpdate,
    handleUpdateHostContext,
    handleUpdateProject,
    hostsTabSelectedHostId,
    isAuthLoading,
    isAuthenticated,
    isBillingContextPending,
    isLoadingRemoteProjects,
    areServersHydrated,
    isSelectedServerSyncing,
    isWorkOsLoading,
    navigateToTarget,
    pendingDashboardOAuth,
    playgroundServerSelectorProps,
    posthog,
    projectServers,
    projects,
    registryEnabled,
    remoteFirstRunOnboardingShown,
    routeOrganizationId,
    routeOrganizationSection,
    saveServerConfigWithoutConnecting,
    selectedMCPConfig,
    selectedServerEntry,
    setPlaygroundOnboarding,
    setActiveHostId,
    setEvalChatHandoff,
    setHostsTabSelectedHostId,
    setSelectedMCPConfigs,
    setSelectedServer,
    shellBillingStatus,
    toggleServerSelection,
    upgradePlanForActiveTab,
    workOsUser,
    xaaEnabled,
    xaaServerModalNonce,
    oauthServerModalNonce,
  };

  const appContent = (
    <SidebarProvider defaultOpen={true}>
      <AppChromeSidebar
        hidden={playgroundOnboarding}
        onNavigate={handleNavigate}
        activeTab={activeTab}
        projects={projects}
        activeProjectId={activeProjectId}
        onSwitchProject={handleSidebarSwitchProject}
        onCreateProject={handleCreateProject}
        onDeleteProject={handleDeleteProject}
        isLoadingProjects={isLoadingRemoteProjects}
        activeOrganizationId={activeOrganizationId}
        activeOrganizationName={activeOrganizationName}
        onSwitchOrganization={handleSidebarSwitchOrganization}
        onSwitchActiveOrganization={handleSwitchActiveOrganization}
        onProjectShared={handleProjectShared}
        billingUiEnabled={billingUiEnabled}
        billingGateDenied={sidebarGateDenied}
        billingGateEnforcementActive={billingGateEnforcementActive}
        isCreateProjectDisabled={isCreateProjectDisabled}
        createProjectDisabledReason={createProjectDisabledReason}
        onBeforeSignOut={disconnectRuntimeServersForAuthExit}
      />
      <SidebarInset className="flex flex-col min-h-0">
        <AppChromeHeader
          hidden={playgroundOnboarding || activeTab === "home"}
          activeServerSelectorProps={activeServerSelectorProps}
          globalHostBarProps={globalHostBarProps}
        />
        <div className="flex h-full min-h-0 min-w-0 flex-1 flex-col overflow-hidden">
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
          <AppRouteReactContext.Provider value={routeContext}>
            {locationContext ? (
              <Outlet context={routeContext} />
            ) : (
              <NoRouterRouteBody activeTab={activeTab} />
            )}
          </AppRouteReactContext.Provider>
        </div>
      </SidebarInset>
      <AgentSidePanelMount
        projectId={activeProjectId ?? null}
        organizationId={activeOrganizationId ?? null}
        activeTab={activeTab}
      />
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
                  navigateToTarget(
                    `organizations/${billingOrganizationId}/billing`
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

  // Vanity-domain embed (caniuse.dev): render the matched route
  // (`HostCompareRoute bare`) full-bleed without the sidebar/header chrome.
  // Still nested inside every provider in the return below, so auth, project,
  // and the guest session resolve exactly as on the normal route.
  const bareCompareContent = (
    <div className="flex h-screen w-screen flex-col overflow-hidden bg-background">
      {/* Subtle branding + entry point back to the full product. */}
      <div className="flex shrink-0 items-center justify-between gap-3 border-b border-border px-4 py-2">
        <a
          href={MAIN_PRODUCT_URL}
          className="text-[15px] font-semibold tracking-tight text-foreground"
          aria-label="MCPJam home"
        >
          MCP<span className="text-primary">Jam</span>
        </a>
        <a
          href={MAIN_PRODUCT_URL}
          className="inline-flex items-center gap-1 text-[12px] text-muted-foreground transition-colors hover:text-foreground"
        >
          Open the full app
          <span aria-hidden>↗</span>
        </a>
      </div>
      <div className="min-h-0 flex-1">
        <AppRouteReactContext.Provider value={routeContext}>
          {locationContext ? (
            <Outlet context={routeContext} />
          ) : (
            <NoRouterRouteBody activeTab={activeTab} />
          )}
        </AppRouteReactContext.Provider>
      </div>
    </div>
  );

  return (
    <PreferencesStoreProvider
      themeMode={initialThemeMode}
      themePreset={initialThemePreset}
    >
      <ProjectClientConfigSync
        activeProjectId={activeProjectId}
        savedClientConfig={activeProject?.clientConfig}
      />
      <AppStateProvider appState={effectiveAppState}>
        <ServerActionsProvider
          actions={{
            ensureServersReady,
            runtimeDisconnectServer: handleRuntimeDisconnect,
            reconnectServer: reconnectServerForClientSwitch,
            setSelectedServerNames: setSelectedMCPConfigs,
          }}
        >
          <ActiveHostServerReconciler
            projectId={convexProjectId}
            isAuthenticated={isAuthenticated}
            activeHost={activeHost}
            activeHostId={activeHostId}
          />
          <AppReadyProvider
            isLoadingAppState={isLoading}
            isConvexAuthLoading={isAuthLoading}
            isConvexAuthenticated={isAuthenticated}
            effectiveActiveProjectId={activeProjectId}
            isLoadingRemoteProjects={isLoadingRemoteProjects}
          >
            <Toaster />
            <MCPJamLimitDialog />
            <div
              data-testid="app-shell"
              aria-hidden={shouldShowBillingHandoffOverlay || undefined}
              className={
                shouldShowBillingHandoffOverlay
                  ? "pointer-events-none opacity-0"
                  : undefined
              }
              inert={shouldShowBillingHandoffOverlay || undefined}
            >
              <HostedShellGate
                state={effectiveHostedShellGateState}
                loadingMessage={
                  shouldShowPendingDashboardOAuthGate
                    ? pendingDashboardOAuthMessage
                    : undefined
                }
                onSignIn={() => {
                  if (chatboxPathToken) {
                    writeChatboxSignInReturnPath(window.location.pathname);
                  }
                  signIn();
                }}
                onSignOut={() => {
                  void (async () => {
                    try {
                      await disconnectRuntimeServersForAuthExit();
                    } finally {
                      await signOut();
                    }
                  })();
                }}
              >
                {isChatboxChatRoute ? (
                  <ChatboxChatPage
                    pathToken={chatboxPathToken}
                    onExitChatboxChat={() => setExitedChatboxChat(true)}
                  />
                ) : isBareCompareRoute ? (
                  bareCompareContent
                ) : (
                  appContent
                )}
              </HostedShellGate>
            </div>
            {shouldShowBillingHandoffOverlay ? (
              <BillingHandoffLoading overlay />
            ) : null}
          </AppReadyProvider>
        </ServerActionsProvider>
      </AppStateProvider>
    </PreferencesStoreProvider>
  );
}
