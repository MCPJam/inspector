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
import { AlertTriangle, Construction, Loader2 } from "lucide-react";
import { toast } from "sonner";
import { MCPJamLimitDialog } from "./components/mcpjam-limit-dialog";
import { ServersTab } from "./components/ServersTab";
import { ToolsTab } from "./components/ToolsTab";
import { ResourcesTab } from "./components/ResourcesTab";
import { PromptsTab } from "./components/PromptsTab";
import { SkillsTab } from "./components/SkillsTab";
import { LearningTab } from "./components/LearningTab";
import { TasksTab } from "./components/TasksTab";
import { HostStyledChatTabV2 } from "./components/HostStyledChatTabV2";
import type { EvalChatHandoff } from "./lib/eval-chat-handoff";
import { EvalsTab } from "./components/EvalsTab";
import { CiEvalsTab } from "./components/CiEvalsTab";
import { ViewsTab } from "./components/ViewsTab";
import { ChatboxesTab } from "./components/ChatboxesTab";
import { SettingsTab } from "./components/SettingsTab";
import { ProjectSettingsTab } from "./components/ProjectSettingsTab";
import { ProjectClientConfigSync } from "./components/client-config/ProjectClientConfigSync";
import { TracingTab } from "./components/TracingTab";
import { AuthTab } from "./components/AuthTab";
import { OAuthFlowTab } from "./components/OAuthFlowTab";
import { ConformanceTab } from "./components/conformance/ConformancePanel";
import { XAAFlowTab } from "./components/xaa/XAAFlowTab";
import { ErrorBoundary } from "./components/ui/error-boundary";
import { AppBuilderTab } from "./components/ui-playground/AppBuilderTab";
import { EmptyState } from "./components/ui/empty-state";
import { EXCALIDRAW_SERVER_NAME } from "./lib/excalidraw-quick-connect";
import { isFirstRunEligible } from "./lib/onboarding-state";
import { ProfileTab } from "./components/ProfileTab";
import { BillingUpsellGate } from "./components/billing/BillingUpsellGate";
import { OrganizationsTab } from "./components/OrganizationsTab";
import { SupportTab } from "./components/SupportTab";
import { RegistryTab } from "./components/RegistryTab";
import OAuthDebugCallback from "./components/oauth/OAuthDebugCallback";
import OAuthDesktopReturnNotice from "./components/oauth/OAuthDesktopReturnNotice";
import { MCPSidebar } from "./components/mcp-sidebar";
import { SidebarInset, SidebarProvider } from "./components/ui/sidebar";
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
import { PreferencesStoreProvider } from "./stores/preferences/preferences-provider";
import { Toaster } from "@mcpjam/design-system/sonner";
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
import {
  isHostedHashTabAllowed,
  normalizeHostedHashTab,
} from "./lib/hosted-tab-policy";
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
  sanitizeHostedOAuthErrorMessage,
  clearHostedOAuthResumeMarker,
  writeHostedOAuthResumeMarker,
} from "./lib/hosted-oauth-resume";
import {
  completeHostedOAuthCallback,
  handleOAuthCallback,
} from "./lib/oauth/mcp-oauth";
import { buildElectronMcpCallbackUrl } from "./hooks/use-server-state";
import { getEffectiveProjectClientCapabilities } from "./lib/client-config";
import {
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
  useCurrentOrgRoute,
} from "./lib/app-navigation";
import {
  Navigate,
  Outlet,
  UNSAFE_LocationContext,
  useOutletContext,
} from "react-router";
import { useProjectClientConfigSyncPending } from "./hooks/use-project-client-config-sync-pending";
import { ingestOAuthTraceLogs } from "./stores/traffic-log-store";
import { clearGuestSession, getGuestBearerToken } from "./lib/guest-session";
import type {
  NavigateInspectorCommand,
  OpenAppBuilderInspectorCommand,
  SelectServerInspectorCommand,
} from "@/shared/inspector-command.js";

const OCCUPATION_GATE_ROLLOUT_MS = Date.parse("2026-04-29T00:00:00.000Z");

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

function getNormalizedPathParts(pathname: string): string[] {
  const parts = pathname.replace(/^\/+/, "").split("/").filter(Boolean);
  if (parts.length === 0) return ["servers"];
  parts[0] = normalizeHostedHashTab(parts[0] || "servers");
  return parts;
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
    value,
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
  if (hidden) {
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
    case "oauth-flow":
      return <OAuthFlowRoute />;
    case "xaa-flow":
      return <XAAFlowRoute />;
    case "tracing":
      return <TracingRoute />;
    case "chat-v2":
      return <ChatV2Route />;
    case "chatboxes":
      return <ChatboxesRoute />;
    case "app-builder":
      return <AppBuilderRoute />;
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
    isLoadingRemoteProjects,
    handleProjectShared,
    handleLeaveProject,
    registryEnabled,
    handleNavigate,
    handleUpdateClientConfig,
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
      isLoadingProjects={isLoadingRemoteProjects}
      onProjectShared={handleProjectShared}
      onLeaveProject={() => handleLeaveProject(activeProjectId)}
      isRegistryEnabled={registryEnabled === true}
      onNavigateToRegistry={
        registryEnabled === true ? () => handleNavigate("registry") : undefined
      }
      onSaveClientConfig={handleUpdateClientConfig}
    />
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
  const { selectedMCPConfig, appState } = useAppRouteContext();
  return (
    <div className="h-full overflow-hidden">
      <ToolsTab
        serverConfig={selectedMCPConfig}
        serverName={appState.selectedServer}
      />
    </div>
  );
}

export function EvalsRoute() {
  const {
    playgroundEnabled,
    billingUiEnabled,
    activeTabBillingLocked,
    activeTabBillingFeature,
    convexProjectId,
    ensureServersReady,
    handleContinueEvalInChat,
  } = useAppRouteContext();

  if (playgroundEnabled === false) {
    return (
      <EmptyState
        icon={Construction}
        title="Playground Coming Soon"
        description="The Playground is under construction. Stay tuned!"
      />
    );
  }

  if (billingUiEnabled && activeTabBillingLocked && activeTabBillingFeature) {
    return <ActiveBillingUpsellGate />;
  }

  return (
    <EvalsTab
      projectId={convexProjectId}
      ensureServersReady={ensureServersReady}
      onContinueInChat={handleContinueEvalInChat}
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
          <p className="mt-4 text-sm text-muted-foreground">
            Loading Runs...
          </p>
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

export function ChatboxesRoute() {
  const {
    billingUiEnabled,
    activeTabBillingLocked,
    activeTabBillingFeature,
    billingProjectId,
    activeProjectBillingOrganizationId,
    isBillingContextPending,
    ensureServersReady,
  } = useAppRouteContext();

  if (billingUiEnabled && activeTabBillingLocked && activeTabBillingFeature) {
    return <ActiveBillingUpsellGate />;
  }

  return (
    <ChatboxesTab
      projectId={billingProjectId}
      organizationId={activeProjectBillingOrganizationId}
      isBillingContextPending={isBillingContextPending}
      ensureServersReady={ensureServersReady}
    />
  );
}

export function ResourcesRoute() {
  const { selectedMCPConfig, appState } = useAppRouteContext();
  return (
    <div className="h-full overflow-hidden">
      <ResourcesTab
        serverConfig={selectedMCPConfig}
        serverName={appState.selectedServer}
      />
    </div>
  );
}

export function PromptsRoute() {
  const { selectedMCPConfig, appState } = useAppRouteContext();
  return (
    <div className="h-full overflow-hidden">
      <PromptsTab
        serverConfig={selectedMCPConfig}
        serverName={appState.selectedServer}
      />
    </div>
  );
}

export function SkillsRoute() {
  return <SkillsTab />;
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
      />
    </ErrorBoundary>
  );
}

export function XAAFlowRoute() {
  const { xaaEnabled, appState } = useAppRouteContext();
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
        serverConfigs={appState.servers}
        selectedServerName={appState.selectedServer}
      />
    </ErrorBoundary>
  );
}

export function ChatV2Route() {
  const {
    connectedOrConnectingServerConfigs,
    appState,
    projectServers,
    toggleServerSelection,
    handleReconnect,
    handleConnect,
    setSelectedMCPConfigs,
    activeMcpProfile,
    evalChatHandoff,
    setEvalChatHandoff,
  } = useAppRouteContext();

  return (
    <HostStyledChatTabV2
      connectedOrConnectingServerConfigs={connectedOrConnectingServerConfigs}
      selectedServerNames={appState.selectedMultipleServers}
      allServerConfigs={projectServers}
      onServerToggle={toggleServerSelection}
      onReconnectServer={handleReconnect}
      onAddServer={handleConnect}
      onSelectedServerNamesChange={setSelectedMCPConfigs}
      enableMultiModelChat
      showHostStyleSelector
      activeMcpProfile={activeMcpProfile}
      evalChatHandoff={evalChatHandoff}
      onEvalChatHandoffConsumed={(id) =>
        setEvalChatHandoff((current: EvalChatHandoff | null) =>
          current?.id === id ? null : current
        )
      }
    />
  );
}

export function TracingRoute() {
  return <TracingTab />;
}

export function AppBuilderRoute() {
  const {
    selectedMCPConfig,
    appState,
    projectServers,
    activeProjectId,
    workOsUser,
    isWorkOsLoading,
    isAuthenticated,
    activeProject,
    remoteFirstRunOnboardingShown,
    isSelectedServerSyncing,
    handleConnect,
    handleUpdateHostContext,
    ensureServersReady,
    setAppBuilderOnboarding,
    playgroundServerSelectorProps,
  } = useAppRouteContext();

  return (
    <AppBuilderTab
      serverConfig={selectedMCPConfig}
      serverName={appState.selectedServer}
      servers={projectServers}
      activeProjectId={activeProjectId}
      isSignedInWithWorkOs={!!workOsUser}
      isWorkOsAuthLoading={isWorkOsLoading}
      isConvexAuthenticated={isAuthenticated}
      isProjectProvisioned={Boolean(activeProject?.sharedProjectId)}
      hasSeenFirstRunOnboarding={remoteFirstRunOnboardingShown}
      isServerSyncing={isSelectedServerSyncing}
      onConnect={handleConnect}
      onSaveHostContext={handleUpdateHostContext}
      ensureServersReady={ensureServersReady}
      onOnboardingChange={setAppBuilderOnboarding}
      playgroundServerSelectorProps={playgroundServerSelectorProps}
      enableMultiModelChat
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
      onNavigateAway={() => handleNavigate("servers")}
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
  return <Navigate to={routePaths.chatV2} replace />;
}

export function ServersRedirectRoute() {
  return <Navigate to={routePaths.servers} replace />;
}

export default function App() {
  const activeTab = useActiveTab();
  const currentOrgRoute = useCurrentOrgRoute();
  const [evalChatHandoff, setEvalChatHandoff] =
    useState<EvalChatHandoff | null>(null);
  const [
    optimisticallyDeletedOrganizationIds,
    setOptimisticallyDeletedOrganizationIds,
  ] = useState<string[]>([]);
  const [appBuilderOnboarding, setAppBuilderOnboarding] = useState(false);
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
  const playgroundEnabled = useFeatureFlagEnabled("playground-enabled");
  const evaluateRunsEnabled = useFeatureFlagEnabled("evaluate-runs");
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
  const [hostedOAuthHandling, setHostedOAuthHandling] = useState(() => {
    if (!HOSTED_MODE) {
      return false;
    }

    const callbackContext = getHostedOAuthCallbackContext();
    return callbackContext != null && callbackContext.surface !== "project";
  });
  const [exitedChatboxChat, setExitedChatboxChat] = useState(false);
  const chatboxPathToken = HOSTED_MODE
    ? getChatboxPathTokenFromLocation()
    : null;
  const chatboxSession = HOSTED_MODE ? readChatboxSession() : null;
  const hostedRouteKind = useMemo(() => {
    if (!HOSTED_MODE) {
      return null;
    }

    if (chatboxPathToken) {
      return "chatbox" as const;
    }

    if (chatboxSession) {
      return "chatbox" as const;
    }

    return null;
  }, [chatboxPathToken, chatboxSession]);
  const isChatboxChatRoute =
    HOSTED_MODE && !exitedChatboxChat && hostedRouteKind === "chatbox";

  useEffect(() => {
    setEvaluateRunsFlagsLoaded(posthog.featureFlags?.hasLoadedFlags === true);

    return posthog.onFeatureFlags(() => {
      setEvaluateRunsFlagsLoaded(posthog.featureFlags?.hasLoadedFlags === true);
    });
  }, [posthog]);
  const isHostedChatRoute = isChatboxChatRoute;
  // Resolve the current route from the React Router pathname. Read via context
  // directly (not useLocation) to keep the hook-call shape unconditional.
  const locationContext = useContext(UNSAFE_LocationContext);
  const locationForRoute = locationContext?.location ?? null;
  const currentPathname =
    locationForRoute?.pathname ?? window.location.pathname ?? "/";
  const currentPathParts = useMemo(
    () => getNormalizedPathParts(currentPathname),
    [currentPathname]
  );
  const routeOrganizationId = currentOrgRoute?.orgId;
  const routeOrganizationSection = currentOrgRoute?.orgSection;
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
    ? effectiveOrganizations.some(
        (org) => org._id === routeOrganizationId
      )
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
                  "Your guest session expired. Reopen the chatbox link and try again.",
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
  // Ensure a `users` row exists after Convex auth
  const { isEnsuringUser } = useEnsureDbUser();

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
      clearChatboxSignInReturnPath();
      clearBillingSignInReturnPath();
      window.history.replaceState(
        {},
        "",
        chatboxReturnPath ?? billingReturnPath ?? "/"
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
    projectServers,
    connectedOrConnectingServerConfigs,
    selectedMCPConfig,
    selectedServerEntry,
    isSelectedServerSyncing,
    handleConnect,
    handleDisconnect,
    handleReconnect,
    ensureServersReady,
    syncAgentStatus,
    handleUpdate,
    handleRemoveServer,
    setSelectedServer,
    setSelectedMCPConfigs,
    toggleServerSelection,
    setSelectedMultipleServersToAllServers,
    projects,
    activeProjectId,
    handleSwitchProject,
    handleCreateProject,
    handleLeaveProject,
    handleUpdateProject,
    handleUpdateClientConfig,
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
  } = useAppState({
    currentUserId: workOsUser?.id ?? null,
    currentActorKey: actorKey,
    hasOrganizations: effectiveOrganizations.length > 0,
    isLoadingOrganizations,
    validOrganizations: effectiveOrganizations,
    routeOrganizationId: hasRouteOrganization ? routeOrganizationId : undefined,
  });
  useInspectorCommandBus();
  // One-time migration from legacy localStorage state to Convex. No-op in
  // hosted mode and after the first successful run; safe to keep in the tree.
  useLocalStateMigration({
    isAuthenticated,
    isUserBootstrapping: isEnsuringUser,
    organizationId: activeOrganizationId,
  });
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
    isLoadingRemoteProjects,
  });
  const hostedChatShellGateState = resolveHostedShellGateState({
    hostedMode: HOSTED_MODE,
    nonProdLockdown: NON_PROD_LOCKDOWN,
    isConvexAuthLoading: isAuthLoading,
    isConvexAuthenticated: isAuthenticated,
    isWorkOsLoading,
    hasWorkOsUser: !!workOsUser,
    workOsUserEmail: workOsUser?.email ?? null,
    isLoadingRemoteProjects: false,
  });
  const baseHostedShellGateState = isHostedChatRoute
    ? hostedChatShellGateState
    : hostedShellGateState;
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
  const hasAnyFirstRunBlockingProjectServers = Object.keys(
    projectServers
  ).some((serverName) => serverName !== EXCALIDRAW_SERVER_NAME);
  const remoteFirstRunOnboardingShown =
    currentUser == null
      ? undefined
      : currentUser.hasSeenOnboarding === true ||
        currentUser.hasCompletedOnboarding === true;
  const hasSeenFirstRunOnboarding = remoteFirstRunOnboardingShown === true;
  const isHostedDefaultRoute = activeTab === "servers";
  const shouldHoldHostedDefaultRouteForAuth =
    HOSTED_MODE &&
    !isHostedChatRoute &&
    isHostedDefaultRoute &&
    hostedShellGateState === "auth-loading";

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
      activeTab === "app-builder" ||
      activeTab === "tools" ||
      activeTab === "resources" ||
      activeTab === "prompts" ||
      activeTab === "tasks" ||
      activeTab === "conformance" ||
      activeTab === "auth";
    if (!needsServer || selectedMCPConfig) return;

    const firstConnected = Object.entries(projectServers).find(
      ([, server]) => (server as any).connectionStatus === "connected"
    );
    if (firstConnected) {
      setSelectedServer(firstConnected[0]);
    }
  }, [activeTab, selectedMCPConfig, projectServers, setSelectedServer]);

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
  const hostedClientCapabilities = getEffectiveProjectClientCapabilities(
    activeProject?.clientConfig
  ) as Record<string, unknown>;
  const convexProjectId = activeProject?.sharedProjectId ?? null;
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
  const isCreateProjectDisabled =
    projectCreationGate.isDenied ||
    guestProjectLimitReached ||
    noOrganizationsAvailable;
  const createProjectDisabledReason = guestProjectLimitReached
    ? "Sign in to create more projects"
    : noOrganizationsAvailable
    ? "Create or join an organization to create projects"
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
  useApiContext({
    projectId: convexProjectId,
    serverIdsByName: hostedServerIdsByName,
    clientCapabilities: hostedClientCapabilities,
    clientConfigSyncPending: isClientConfigSyncPending,
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

  const previousActiveTabRef = useRef(activeTab);
  useEffect(() => {
    const previousActiveTab = previousActiveTabRef.current;
    if (activeTab === "chat-v2" && previousActiveTab !== "chat-v2") {
      setSelectedMultipleServersToAllServers();
    }
    previousActiveTabRef.current = activeTab;
  }, [activeTab, setSelectedMultipleServersToAllServers]);

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

    const unregisterOpenAppBuilder = registerInspectorCommandHandler(
      "openAppBuilder",
      async (rawCommand) => {
        const command = rawCommand as OpenAppBuilderInspectorCommand;

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
          const runtimeForPersist = serverState.runtimeServer;
          if (runtimeForPersist?.connectionStatus === "connected") {
            void persistRuntimeServerToProjectRef.current(
              command.payload.serverName,
              runtimeForPersist
            );
          }
        }

        navigateApp(routePaths.appBuilder);
        await waitForUiCommit();

        return {
          activeTab: "app-builder",
          selectedServer:
            command.payload.serverName || selectedServerRef.current || "none",
        };
      }
    );

    return () => {
      unregisterNavigate();
      unregisterSelectServer();
      unregisterOpenAppBuilder();
    };
  }, [
    getInspectorServerState,
    setSelectedServer,
    syncAgentStatus,
  ]);

  useLayoutEffect(() => {
    if (isHostedChatRoute) {
      return;
    }

    if (isWorkOsLoading) {
      return;
    }

    if (effectiveHostedShellGateState !== "ready") {
      return;
    }

    if (isAuthenticated && currentUser === undefined) {
      return;
    }

    if (hasSeenFirstRunOnboarding) {
      return;
    }

    // Hosted guests need Convex auth and their actor-owned project before App
    // Builder can auto-connect Excalidraw against the right project.
    if (
      HOSTED_MODE &&
      (!isAuthenticated ||
        isLoadingRemoteProjects ||
        !activeProjectId ||
        activeProjectId === "none")
    ) {
      return;
    }

    if (
      isFirstRunEligible(
        hasAnyFirstRunBlockingProjectServers,
        `#${activeTab}`,
        !!workOsUser,
        remoteFirstRunOnboardingShown
      )
    ) {
      navigateApp(routePaths.appBuilder);
    }
  }, [
    activeProjectId,
    activeTab,
    currentUser,
    effectiveHostedShellGateState,
    hasSeenFirstRunOnboarding,
    hasAnyFirstRunBlockingProjectServers,
    isAuthenticated,
    isHostedChatRoute,
    isLoadingRemoteProjects,
    isWorkOsLoading,
    remoteFirstRunOnboardingShown,
    workOsUser,
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

    if (activeTabBillingLocked && activeTabBillingFeature) {
      toast.error(
        `${formatBillingFeatureName(
          activeTabBillingFeature
        )} is not included in the ${formatPlanName(
          shellBillingStatus?.plan
        )} plan. Upgrade the organization to continue.`
      );
      navigateApp(routePaths.servers, { replace: true });
    } else if (activeTab === "registry" && registryEnabled !== true) {
      navigateApp(routePaths.servers, { replace: true });
    } else if (
      activeTab === "learning" &&
      (learningEnabled !== true || !isAuthenticated)
    ) {
      navigateApp(routePaths.servers, { replace: true });
    } else if (activeTab === "client-config") {
      navigateApp(routePaths.servers, { replace: true });
    } else if (activeTab === "conformance" && conformanceEnabled !== true) {
      navigateApp(routePaths.servers, { replace: true });
    } else if (activeTab === "xaa-flow" && xaaEnabled !== true) {
      navigateApp(routePaths.servers, { replace: true });
    }
  }, [
    conformanceEnabled,
    registryEnabled,
    learningEnabled,
    evaluateRunsFlagsLoaded,
    evaluateRunsEnabled,
    xaaEnabled,
    isAuthenticated,
    activeTab,
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
      // If the user is currently on an org-scoped route (e.g. the org's
      // overview or billing page), redirect to the same section under the
      // new org so the page they're looking at actually changes.
      if (routeOrganizationId) {
        const section = routeOrganizationSection ?? "overview";
        navigateApp(buildOrganizationPath(organizationId, section));
        return;
      }
      // If the URL embeds an org-A resource id (e.g. `/evals/suite/abc`,
      // `/chat-v2/threadId`, `/views/viewId`), strip the sub-path so the
      // user lands on the tab's clean root view for the new org instead of
      // a "not found" page.
      if (currentPathParts.length > 1) {
        navigateToTarget(currentPathParts[0] ?? "servers");
      }
    },
    [
      activeOrganizationId,
      setActiveOrganizationId,
      routeOrganizationId,
      routeOrganizationSection,
      currentPathParts,
      navigateToTarget,
    ]
  );

  const handleContinueEvalInChat = useCallback(
    (handoff: Omit<EvalChatHandoff, "id">) => {
      setSelectedMCPConfigs(handoff.serverNames);
      setEvalChatHandoff({
        ...handoff,
        id: `eval-chat-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      });
      navigateApp(routePaths.chatV2);
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
    navigateToTarget(navigationTarget, { replace: true });
  }, [
    activeTab,
    hasRouteOrganization,
    isAuthenticated,
    isLoadingOrganizations,
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
      navigateApp(routePaths.servers);
    },
    [
      activeOrganizationId,
      activeProject?.organizationId,
      clearLocalFallbackProjectSelection,
      clearConvexActiveProjectSelection,
      effectiveOrganizations,
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
    if (activeTab !== "app-builder") return undefined;
    return {
      serverConfigs: projectServers,
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
    projectServers,
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

  if (shouldHoldHostedDefaultRouteForAuth) {
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
    activeTab === "oauth-flow" ||
    (activeTab === "xaa-flow" && xaaEnabled === true) ||
    activeTab === "chat" ||
    activeTab === "views";

  const activeServerSelectorProps: ActiveServerSelectorProps | undefined =
    shouldShowActiveServerSelector
      ? {
          serverConfigs: projectServers,
          selectedServer: appState.selectedServer,
          onServerChange: setSelectedServer,
          onConnect: handleConnect,
          onReconnect: handleReconnect,
          isMultiSelectEnabled: activeTab === "chat",
          onMultiServerToggle: toggleServerSelection,
          selectedMultipleServers: appState.selectedMultipleServers,
          showOnlyOAuthServers:
            activeTab === "oauth-flow" ||
            (activeTab === "xaa-flow" && xaaEnabled === true),
          autoSelectFilteredServer:
            activeTab !== "oauth-flow" &&
            !(activeTab === "xaa-flow" && xaaEnabled === true),
          showOnlyServersWithViews: activeTab === "views",
          serversWithViews: serversWithViews,
          hasMessages: false,
        }
      : undefined;

  const routeContext: AppRouteContext = {
    activeMcpProfile,
    activeOrganizationId,
    activeOrganizationName,
    activeProject,
    activeProjectBillingOrganizationId,
    activeProjectId,
    activeTabBillingFeature,
    activeTabBillingLocked,
    appState,
    billingOrganizationId,
    billingProjectId,
    billingUiEnabled,
    checkoutIntentForBilling,
    connectedOrConnectingServerConfigs,
    consumeCheckoutIntent,
    convexProjectId,
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
    handleRefreshTokensFromOAuthFlow,
    handleRemoveServer,
    handleUpdate,
    handleUpdateClientConfig,
    handleUpdateHostContext,
    handleUpdateProject,
    isAuthenticated,
    isBillingContextPending,
    isLoadingRemoteProjects,
    isSelectedServerSyncing,
    isWorkOsLoading,
    navigateToTarget,
    pendingDashboardOAuth,
    playgroundEnabled,
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
    setAppBuilderOnboarding,
    setEvalChatHandoff,
    setSelectedMCPConfigs,
    setSelectedServer,
    shellBillingStatus,
    toggleServerSelection,
    upgradePlanForActiveTab,
    workOsUser,
    xaaEnabled,
  };

  const appContent = (
    <SidebarProvider defaultOpen={true}>
      <AppChromeSidebar
        hidden={appBuilderOnboarding}
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
      />
      <SidebarInset className="flex flex-col min-h-0">
        <AppChromeHeader
          hidden={appBuilderOnboarding}
          activeServerSelectorProps={activeServerSelectorProps}
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
              void signOut();
            }}
          >
            {isChatboxChatRoute ? (
              <ChatboxChatPage
                pathToken={chatboxPathToken}
                onExitChatboxChat={() => setExitedChatboxChat(true)}
              />
            ) : (
              appContent
            )}
          </HostedShellGate>
        </div>
        {shouldShowBillingHandoffOverlay ? (
          <BillingHandoffLoading overlay />
        ) : null}
      </AppReadyProvider>
      </AppStateProvider>
    </PreferencesStoreProvider>
  );
}
