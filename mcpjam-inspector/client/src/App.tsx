import { useConvexAuth, useQuery } from "convex/react";
import {
  useCallback,
  useContext,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type ComponentProps,
} from "react";
import { useAuth } from "@workos-inc/authkit-react";
import { AlertTriangle, Loader2, MessageSquare, Users } from "lucide-react";
import { toast } from "@/lib/toast";
import { MCPJamLimitDialog } from "./components/mcpjam-limit-dialog";
import { PlanLimitDialog } from "./components/billing/PlanLimitDialog";
import { SessionRefreshBanner } from "./components/session-refresh-banner";
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
import { EvaluateTab } from "./components/EvaluateTab";
import { CiEvalsTab } from "./components/CiEvalsTab";
import { UserTestingTab } from "./components/UserTestingTab";
import { SwarmsTab } from "./components/swarms/SwarmsTab";
import { EmptyState } from "./components/ui/empty-state";
import {
  canManageAsOwnerOrAdmin,
  canViewSwarms,
  shouldQueryProjectId,
  useProjectQueries,
  useViewerProjectRole,
} from "./hooks/useProjects";
import { ProjectEnvironmentsRoute } from "./components/project-environments/ProjectEnvironmentsRoute";
import { SessionsPanel } from "./components/sessions/SessionsPanel";
import { SettingsTab } from "./components/SettingsTab";
import { ApiKeysRoute } from "./components/settings/ApiKeysRoute";
import { GithubChecksRoute } from "./components/settings/GithubChecksRoute";
import { GithubInstallCallbackRoute } from "./components/settings/GithubInstallCallbackRoute";
import { IntegrationsRoute } from "./components/settings/IntegrationsRoute";
import { ProjectSettingsTab } from "./components/ProjectSettingsTab";
import { ProjectClientConfigSync } from "./components/client-config/ProjectClientConfigSync";
import { ActiveHostServerReconciler } from "./components/ActiveHostServerReconciler";
import { TracingTab } from "./components/TracingTab";
import { WebmcpInspectorTab } from "./components/webmcp-inspector/WebmcpInspectorTab";
import { OAuthFlowTab } from "./components/OAuthFlowTab";
import { ConformanceTab } from "./components/conformance/ConformancePanel";
import {
  ConformanceHistory,
  ConformanceRunDetailPage,
  ConformanceSharedPage,
} from "./components/conformance/ConformanceHistory";
import { EvalRunSharedPage } from "./components/evals/EvalRunSharedPage";
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
import { CaniuseCapabilityPage } from "./components/hosts/comparison/CaniuseCapabilityPage";
import { HostSectionTabs } from "./components/hosts/HostSectionTabs";
import { ConnectViewHeader } from "./components/hosts/ConnectViewHeader";
import { ComputerTabView } from "./components/computer/ComputerTabView";
import { useComputersEnabledState } from "./hooks/useComputersEnabled";
import { useWebmcpInspectorEnabledState } from "./hooks/useWebmcpInspectorEnabled";
import { useSkillsEnabledState } from "./hooks/useSkillsEnabled";
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
import { AppChromePanel } from "@/components/app-chrome-panel";
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
import { useIsMemberActor } from "./hooks/use-is-member-actor";
import {
  PreferencesStoreProvider,
  usePreferencesStore,
} from "./stores/preferences/preferences-provider";
import { Toaster } from "@mcpjam/design-system/sonner";
import { useElectronOAuth } from "./hooks/useElectronOAuth";
import {
  useHiddenHeaderServers,
  type HeaderSurface,
} from "./hooks/useHiddenHeaderServers";
import { hasDebuggerHeaderServers } from "./lib/debugger-header-servers";
import { usePostHog, useFeatureFlagEnabled } from "posthog-js/react";
import { usePostHogIdentify } from "./hooks/usePostHogIdentify";
import { useSessionRecordingPathGuard } from "./hooks/useSessionRecordingPathGuard";
import { usePostHogOrgContext } from "./hooks/usePostHogOrgContext";
import { useSentryOrgContext } from "./hooks/useSentryOrgContext";
import { useDbUserBootstrapStatus } from "./contexts/db-user-ready-context";
import { AppStateProvider } from "./state/app-state-context";
import { ServerActionsProvider } from "./state/server-actions-context";
import { usePreviewedHostId } from "./hooks/use-previewed-client-id";
import { useOrganizationQueries } from "./hooks/useOrganizations";
import { useOrganizationBilling } from "./hooks/useOrganizationBilling";
import type { BillingFeatureName } from "./hooks/useOrganizationBilling";

// Import global styles
import "./index.css";
import { track } from "./lib/analytics";
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
import { useProjectServers } from "./hooks/useViews";
import { HostedShellGate } from "./components/hosted/HostedShellGate";
import { resolveHostedShellGateState } from "./components/hosted/hosted-shell-gate-state";
import {
  ScenarioChatPage,
  getScenarioPathTokenFromLocation,
} from "./components/hosted/ScenarioChatPage";
import { useApiContext } from "./hooks/hosted/use-hosted-api-context";
import { useHostedClientCapabilities } from "./hooks/hosted/use-hosted-client-capabilities";
import { useLocalStateMigration } from "./hooks/use-local-state-migration";
import { AppReadyProvider } from "./hooks/use-app-ready";
import { useInspectorCommandBus } from "./hooks/use-inspector-command-bus";
import {
  driveChatScopeStepUp,
  resolveScopeStepUpServer,
} from "./lib/scope-step-up";
import { markPendingChatScopeStepUpCancelled } from "./lib/scope-step-up-pending";
import { HOSTED_MODE } from "./lib/config";
import {
  createInspectorCommandClientError,
  registerInspectorCommandHandler,
} from "./lib/inspector-command-handlers";
import { resolveUiNavigationTarget } from "./lib/webmcp/ui-actions";
import { useRegisterUiTools } from "./lib/webmcp/use-register-ui-tools";
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
import { hasProjectDeepLinkParam } from "./lib/project-deep-link";
import {
  buildProjectPath,
  isProjectIdShape,
  readProjectPathSegment,
  stripProjectFromPath,
} from "./lib/project-route";
import { useProjectRouteCoordinator } from "./hooks/use-project-route-coordinator";
import {
  captureAppSignInReturnPath,
  consumeAppSignInReturnPath,
} from "./lib/app-signin-return-path";
import { trackSignInReturnRestored } from "./lib/project-route-telemetry";
import { isHostedTabBlocked } from "./lib/hosted-tab-policy";
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
  clearScenarioSignInReturnPath,
  readScenarioSession,
  readScenarioSignInReturnPath,
} from "./lib/scenario-session";
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
  OAUTH_PENDING_STORAGE_KEY,
} from "./lib/oauth/mcp-oauth";
import {
  buildElectronMcpCallbackUrl,
  resolveEffectiveWireProtocolVersion,
} from "./hooks/use-server-state";
import { disconnectAllRuntimeServers } from "./state/mcp-api";
import {
  isKnownProtocolVersion,
  readTasksPolicy,
  readXaaEnterprisePolicy,
  taskModeForSurface,
  type McpProtocolVersion,
} from "@mcpjam/sdk/browser";
import {
  cloneHostTemplateInput,
  gateMcpToolResultImageRenderingByModelVisibility,
} from "./lib/client-config-v2";
import type { ProjectServerConfigDto } from "./lib/project-server-config";
import {
  shouldQueryHostId,
  useHostList,
  useHostMutations,
} from "@/hooks/useClients";
import { useSandboxesEnabledState } from "@/hooks/useSandboxesEnabled";
import { useUnifiedSessionsEnabledState } from "@/hooks/useUnifiedSessionsEnabled";
import { useEvaluateEnabledState } from "@/hooks/useEvaluateEnabled";
import {
  HOST_TEMPLATES,
  seedFromHostTemplate,
  type HostTemplateId,
} from "@mcpjam/sdk/host-config/templates";
import { useClaudeCodeHostEnabledState } from "./hooks/useClaudeCodeHostEnabled";
import { useCodexHostEnabledState } from "./hooks/useCodexHostEnabled";
import { hostFeatureFlagState } from "@/lib/host-compat/feature-visibility";
import {
  HOST_VERIFY_TAB_PARAM,
  HOST_VERIFY_TEMPLATE_PARAM,
  hostFocusTabToVerifyParam,
  parseHostVerifyTabParam,
} from "./components/hosts/host-verify-deep-link";
import type { HostFocusTabId } from "./components/hosts/redesigned/types";
import {
  buildHostsPath,
  buildOrganizationPath,
  buildProjectSettingsTarget,
  buildProjectSwitchTarget,
  getInvalidOrganizationRouteNavigationTarget,
  isDebugOAuthCallbackPath,
  navigationTargetToPath,
  navigateApp,
  pathnameToActiveTab,
  routePaths,
  scopeNavigationTarget,
  type OrganizationRouteSection,
  useCurrentLocationParts,
  useCurrentSearchParam,
  useActiveTab,
  useAppNavigate,
  useCurrentOrgRoute,
} from "./lib/app-navigation";
import { ScopedNavigate } from "./components/routing/scoped-navigate";
import {
  AppRouteReactContext,
  useAppRouteContext,
  type AppRouteContext,
} from "./lib/app-route-context";
import { useEvalsMode, type EvalsMode } from "./lib/eval-route-url";
import {
  Navigate,
  Outlet,
  UNSAFE_LocationContext,
  useParams,
} from "react-router";
import { useProjectClientConfigSyncPending } from "./hooks/use-project-client-config-sync-pending";
import { ingestOAuthTraceLogs } from "./stores/traffic-log-store";
import { clearGuestSession, getGuestBearerToken } from "./lib/guest-session";
import { publishSelectedServerNames } from "./lib/webmcp/ui-context-source";
import type {
  ConnectServerInspectorCommand,
  DisconnectServerInspectorCommand,
  NavigateInspectorCommand,
  OpenPlaygroundInspectorCommand,
  RemoveServerInspectorCommand,
  SelectServerInspectorCommand,
  SnapshotAppInspectorCommand,
} from "@/shared/inspector-command.js";
import {
  getAppSurfaceByNavSegment,
  isAppSurfaceId,
} from "@/shared/app-surfaces";
import { sanitizeTraceErrorMessage } from "./lib/oauth/trace-redaction";
import { waitForUiToolNames } from "./lib/webmcp/ui-tools-readiness";
import { listSurfaceGroupToolNames } from "./lib/webmcp/groups";
import {
  readAllSurfaceSnapshots,
  readSurfaceSnapshot,
} from "@/lib/webmcp/surface-snapshot-registry";

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
    "Authorization could not be completed. Try again.",
  );
}

function clearHostedCallbackRetryState() {
  clearHostedOAuthPendingState();
  clearHostedOAuthResumeMarker();
  clearGuestSession();
  localStorage.removeItem(OAUTH_PENDING_STORAGE_KEY);
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

/**
 * Redact the OAuth debugger's error-boundary output.
 *
 * Uses the SDK's single trace redactor rather than a local pattern list — this
 * used to be a fourth private copy, and a private copy is how the sensitive-
 * field set drifts.
 *
 * The stack is redacted in ONE pass with a raised cap, not line by line. A
 * multi-line payload can put a JSON credential's key and its value on separate
 * lines, and splitting first hands the redactor two fragments that match
 * neither — so the value survives into copied and reported output. The cap
 * exists for a single error message; a stack legitimately needs more room.
 */
const MAX_REDACTED_STACK = 8_000;

function redactStackLikeText(value: string | null | undefined): string {
  if (!value) return "";
  return sanitizeTraceErrorMessage(value, {
    maxLength: MAX_REDACTED_STACK,
    maxScanned: MAX_REDACTED_STACK * 2,
  });
}

function redactOAuthDebuggerError(error: Error | null) {
  return {
    name: sanitizeTraceErrorMessage(error?.name ?? "Error"),
    message: sanitizeTraceErrorMessage(error?.message ?? "Unknown error"),
    stack: redactStackLikeText(error?.stack),
  };
}

function formatOAuthDebuggerErrorDetails(error: Error | null): string {
  const sanitized = redactOAuthDebuggerError(error);
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
  organizations: ReadonlyArray<{ _id: string; myRole?: string }>,
): string | undefined {
  const firstOwnedOrganization = organizations.find(
    (organization) => organization.myRole === "owner",
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

import { ScoreRunnerPage } from "@/components/score/ScoreRunnerPage";
import { ScoreResultsPage } from "@/components/score/ScoreResultsPage";
import { BenchRunnerPage } from "@/components/score/BenchRunnerPage";
import { BenchResultsPage } from "@/components/score/BenchResultsPage";

/**
 * The no-router render path.
 *
 * REACHABLE — it is what renders when the app runs without React Router
 * (App.tsx mounts it twice). It is easy to assume otherwise because the router
 * table in `router.tsx` looks like the only route map, which is exactly why the
 * two had drifted: the router handles the legacy `chat` and `client-config`
 * aliases and this switch did not, so those two tab ids fell through to
 * `default` and rendered Servers.
 *
 * `client-config` happened to be harmless (Servers IS its redirect target);
 * `chat` was not — it rendered Servers while the sidebar showed Playground.
 * Both are explicit arms now, pointing at the same destinations `router.tsx`
 * uses. When you add a route there, add it here.
 */
function NoRouterRouteBody({ activeTab }: { activeTab: string }) {
  switch (activeTab) {
    // Legacy aliases, mirroring router.tsx's ChatAliasRoute /
    // ServersRedirectRoute. A navigate-away effect also fires for these; the
    // arm is what they render in the meantime, so it must match where they
    // are going.
    case "chat":
      return <PlaygroundRoute />;
    case "client-config":
      return <ServersRoute />;
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
    case "webmcp":
      return <WebmcpInspectorRoute />;
    case "clients":
      return <HostsRoute />;
    case "host-compare":
      return <HostCompareRoute />;
    case "computer":
      return <ComputerRoute />;
    case "scenarios":
      return <ScenariosRoute />;
    case "swarms":
      return <SwarmsRoute />;
    case "environments":
      return <EnvironmentsRoute />;
    case "sessions":
      return <SessionsRoute />;
    case "playground":
      return <PlaygroundRoute />;
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
    case "evaluate":
      return <EvaluateRoute />;
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
  const [previewedHostId] = usePreviewedHostId(convexProjectId);
  const navigate = useAppNavigate();
  // `/servers/:serverId` and `/servers/plugins/:pluginId` — the exact
  // permalink targets on Connect. Both render THIS screen (see `router.tsx`),
  // so the param is the whole difference, and it is threaded down rather than
  // read inside `ServersTab` so the local-mode and unauthenticated branches
  // below keep passing it too.
  const routeParams = useParams<{ serverId?: string; pluginId?: string }>();

  // From /servers, "select a host" means navigate to /hosts/:id. State sync
  // happens in HostsRoute via the URL → hostsTabSelectedHostId effect, so
  // here we only need to drive the URL.
  const handleSelectHost = useCallback(
    (next: string | null) => {
      navigate(next ? buildHostsPath(next) : routePaths.servers);
    },
    [navigate],
  );

  // Local mode: the Connect switcher is the only path to Skills, so it must
  // render regardless of auth/guest/project state. HostsTab (which owns the
  // header when a cloud project exists) bails to a bare view without a
  // projectId, so wrap ServersTabBody ourselves in both degraded states.
  if (!HOSTED_MODE && (!isAuthenticated || !convexProjectId)) {
    return (
      <motion.div
        key="servers-local"
        initial={{ opacity: 0, y: 8 }}
        animate={{ opacity: 1, y: 0 }}
        transition={SNAPPY_RAIL}
        className="flex h-full min-h-0 flex-col"
      >
        <ConnectViewHeader
          value="servers"
          previewedHostId={previewedHostId}
          onChange={(next) => {
            if (next === "servers") {
              navigate(routePaths.servers);
            } else if (next === "host" && previewedHostId) {
              navigate(buildHostsPath(previewedHostId));
            } else if (next === "computer") {
              navigate(routePaths.computer);
            } else if (next === "skills") {
              navigate(routePaths.skills);
            }
          }}
        />
        <div className="min-h-0 flex-1">
          <ServersTabBody
            routeServerId={routeParams.serverId ?? null}
            routePluginId={routeParams.pluginId ?? null}
          />
        </div>
      </motion.div>
    );
  }

  if (!isAuthenticated) {
    return (
      <ServersTabBody
        routeServerId={routeParams.serverId ?? null}
        routePluginId={routeParams.pluginId ?? null}
      />
    );
  }

  return (
    <HostsTab
      projectId={convexProjectId}
      isAuthenticated={isAuthenticated}
      selectedHostId={null}
      onSelectHost={handleSelectHost}
      serversTabElement={
        <ServersTabBody
          routeServerId={routeParams.serverId ?? null}
          routePluginId={routeParams.pluginId ?? null}
        />
      }
    />
  );
}

function ServersTabBody({
  routeServerId = null,
  routePluginId = null,
}: {
  routeServerId?: string | null;
  routePluginId?: string | null;
} = {}) {
  const {
    projectServers,
    handleConnect,
    handleDisconnect,
    handleReconnect,
    handleUpdate,
    handleRemoveServer,
    saveServerConfigWithoutConnecting,
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
      onSaveServerConfig={saveServerConfigWithoutConnecting}
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
      routeServerId={routeServerId}
      routePluginId={routePluginId}
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
  const [previewedHostId, setPreviewedHostId] =
    usePreviewedHostId(convexProjectId);
  const params = useParams<{ hostId?: string }>();
  const navigate = useAppNavigate();
  // The pathname fallback (no-Router renders) reads the LOGICAL path: under
  // the router the live one is `/p/<projectId>/hosts/<id>`, and matching that
  // against `/hosts/` would drop the deep-linked host.
  const fallbackHostPathname =
    typeof window === "undefined"
      ? ""
      : stripProjectFromPath(window.location.pathname);
  const routeHostId =
    params.hostId ??
    (fallbackHostPathname.startsWith(`${routePaths.hosts}/`)
      ? fallbackHostPathname.slice(`${routePaths.hosts}/`.length).split("/")[0]
      : null);
  const urlHostId = useMemo(() => {
    if (!routeHostId) return null;
    let decoded = routeHostId;
    try {
      decoded = decodeURIComponent(routeHostId);
    } catch {
      // Malformed escape: fall through with the raw segment.
    }
    // Trimmed HERE so one canonical id reaches every consumer. `useHost` trims
    // before querying, so a padded `/hosts/%20<id>%20` would otherwise resolve
    // the host while the synced and PERSISTED value kept its whitespace — and
    // `HostsTab` reconciles both against the host list, so it would bounce the
    // user to the list and clear the project's previewed host.
    const trimmed = decoded.trim();
    return trimmed.length > 0 ? trimmed : null;
  }, [routeHostId]);
  // Only a Convex document id may be opened, synced, or persisted. Typed and
  // shared links put clients-catalog slugs here too (`/hosts/chatgpt`, whose
  // supported deep link is `/hosts?template=chatgpt`), and such a value can
  // never resolve to a host. `useHost` skips it; what this adds is keeping it
  // out of the project's PERSISTED previewed host, where it would outlive the
  // URL and reopen a dead id on every later visit to `/hosts`.
  //
  // This gate is SHAPE only, so it settles with no host list at all — which is
  // what separates it from the liveness gate below. A slug never resolves for
  // any project, so it is rejected on the first render rather than waiting out
  // a query that would fail argument validation anyway.
  const idShapedHostId =
    urlHostId && shouldQueryHostId(urlHostId) ? urlHostId : null;

  useEffect(() => {
    // Keyed off the raw segment, so `/hosts/%20` (nothing left after trimming)
    // is cleaned up too rather than sitting on a URL that opens nothing.
    // No toast: a slug was never a client of theirs, so "no longer exists"
    // (what a dead permalink says below) would be telling them the wrong story.
    if (routeHostId && !idShapedHostId) {
      navigate(routePaths.hosts, { replace: true });
    }
  }, [routeHostId, idShapedHostId, navigate]);

  const { hosts: routeHosts, isLoading: isRouteHostListLoading } = useHostList({
    isAuthenticated,
    projectId: convexProjectId,
  });

  // Where the URL's id stands against the project's client list. Client URLs
  // are permalinks, so bookmarks and history outlive the client itself, and
  // `dead` — deleted, or a link from a project this session isn't in — is
  // reachable from ordinary navigation.
  //
  // `pending` is a real state, not a rounding of `dead`: the list is empty for
  // a beat on every cold start (and `useHostList` also reports loading while
  // signed out, or while `convexProjectId` is still a placeholder, because it
  // skips the query in both cases). Calling an id dead in that window would
  // break every working deep link.
  //
  // Reads `idShapedHostId`, not the raw URL id: a non-id has already been sent
  // to `/hosts` by the shape gate above, and routing it through here too would
  // stall it in `pending` on a cold start and then fire the dead-permalink
  // toast at someone who never had that client.
  const urlHostState: "none" | "pending" | "live" | "dead" =
    idShapedHostId === null
      ? "none"
      : isRouteHostListLoading
        ? "pending"
        : routeHosts.some((h) => h.hostId === idShapedHostId)
          ? "live"
          : "dead";

  // The id the canvas may open. A dead id resolves to null HERE, before it
  // reaches shared state, which is what keeps this route out of a fight with
  // `HostsTab`: that component reconciles selection and the previewed host
  // against the same list and clears anything missing, so a route that kept
  // re-syncing the dead id from the URL would have it cleared and re-set on
  // every pass. The corrective navigation below is a React Router transition,
  // and the resulting stream of higher-priority state updates starves it — the
  // canvas never lands on `/hosts`, the loop never ends, and it surfaces either
  // as a pegged CPU core or, when the updates chain synchronously, as "Maximum
  // update depth exceeded" (INSPECTOR-CLIENT-224).
  //
  // A `pending` id stays openable so a legitimate permalink opens its canvas
  // immediately rather than flashing the client list for the length of the
  // query. That optimism is safe because it never leaves memory — see the
  // persistence rule below.
  const openableHostId = urlHostState === "dead" ? null : idShapedHostId;

  // Only a CONFIRMED id is written to the project's previewed client, because
  // that store is on disk and outlives the URL that seeded it. Persisting a
  // `pending` id would file an unverified — possibly deleted — client as the
  // project's preview, and closing the tab mid-load would leave it there to be
  // reopened on the next visit.
  const persistableHostId = urlHostState === "live" ? idShapedHostId : null;

  // Bounce a dead permalink to bare `/hosts`, so the user lands on the client
  // list (or their previously previewed client) instead of on a canvas stuck
  // rendering skeletons for a client that isn't there.
  //
  // `replace`, so the dead URL leaves the history stack: a plain push would
  // leave Back pointing at it, and the bounce would repeat on every Back.
  // Keyed by id so it fires once per arrival rather than once per render —
  // and CLEARED whenever the route isn't sitting on a dead id, because this
  // component stays mounted across `/hosts` ↔ `/hosts/:hostId` (both paths
  // render it, so React reuses the instance and the ref survives). Without the
  // reset, returning to a dead id already bounced once this session would skip
  // both the redirect and the toast, stranding the user on the dead URL.
  const bouncedDeadHostIdRef = useRef<string | null>(null);
  useEffect(() => {
    if (urlHostState !== "dead" || !idShapedHostId) {
      bouncedDeadHostIdRef.current = null;
      return;
    }
    if (bouncedDeadHostIdRef.current === idShapedHostId) return;
    bouncedDeadHostIdRef.current = idShapedHostId;
    navigate(routePaths.hosts, { replace: true });
    toast.error("That client no longer exists. It may have been deleted.");
  }, [urlHostState, idShapedHostId, navigate]);

  // URL is the source of truth for the open host canvas. Sync into shared
  // state so `GlobalHostBar`, `onCanvasReplaceHost`, and other surfaces that
  // still read `hostsTabSelectedHostId` stay aligned.
  useEffect(() => {
    if (hostsTabSelectedHostId !== openableHostId) {
      setHostsTabSelectedHostId(openableHostId);
    }
    if (persistableHostId && previewedHostId !== persistableHostId) {
      setPreviewedHostId(persistableHostId);
    }
  }, [
    openableHostId,
    persistableHostId,
    hostsTabSelectedHostId,
    previewedHostId,
    setHostsTabSelectedHostId,
    setPreviewedHostId,
  ]);

  const handleSelectHost = useCallback(
    (next: string | null) => {
      navigate(next ? buildHostsPath(next) : routePaths.hosts);
    },
    [navigate],
  );

  useTemplateVerifyDeepLink({
    isAuthenticated,
    projectId: convexProjectId,
    navigate,
  });

  if (!isAuthenticated) {
    return <ServersTabBody />;
  }

  return (
    <HostsTab
      projectId={convexProjectId}
      isAuthenticated={isAuthenticated}
      selectedHostId={openableHostId ?? previewedHostId}
      onSelectHost={handleSelectHost}
      serversTabElement={<ServersTabBody />}
    />
  );
}

/**
 * How long the verify deep-link waits for a gated template's rollout flag
 * before treating it as off. PostHog seeds no bootstrap flag values, so a
 * blocked or unreachable relay leaves the flag `undefined` for the life of the
 * mount — without a deadline the link would silently do nothing at all.
 */
export const HOST_TEMPLATE_FLAG_WAIT_MS = 5_000;

/**
 * "Verify against your server" deep-link from the public caniuse surface.
 * `/hosts?template=claude` opens that client's host, creating it from the
 * template (matched by name) when the account doesn't already have one — then
 * navigates to `/hosts/:hostId`, which drops the query param. Runs once per
 * mount; guests are covered because host creation doesn't require a full login.
 */
function useTemplateVerifyDeepLink({
  isAuthenticated,
  projectId,
  navigate,
}: {
  isAuthenticated: boolean;
  projectId: string;
  navigate: (to: string, options?: { replace?: boolean }) => void;
}) {
  const themeMode = usePreferencesStore((s) => s.themeMode);
  const { hosts, isLoading: hostsLoading } = useHostList({
    isAuthenticated,
    projectId,
  });
  const { createHost } = useHostMutations();
  const claudeCodeEnabled = useClaudeCodeHostEnabledState();
  const codexEnabled = useCodexHostEnabledState();
  const requestedTemplateId = useMemo<HostTemplateId | null>(() => {
    if (typeof window === "undefined") return null;
    const raw = new URLSearchParams(window.location.search).get(
      HOST_VERIFY_TEMPLATE_PARAM,
    );
    if (!raw) return null;
    return HOST_TEMPLATES.some((t) => t.id === raw)
      ? (raw as HostTemplateId)
      : null;
  }, []);
  const requestedFocusTab = useMemo<HostFocusTabId | null>(() => {
    if (typeof window === "undefined") return null;
    return parseHostVerifyTabParam(window.location.search);
  }, []);
  const handledRef = useRef(false);
  // Bounded wait for a gated template's rollout flag — see
  // `HOST_TEMPLATE_FLAG_WAIT_MS`. Once it expires an unresolved flag is read as
  // off, so the link fails visibly (bounce + toast) instead of silently.
  const [flagWaitExpired, setFlagWaitExpired] = useState(false);

  useEffect(() => {
    if (!requestedTemplateId) return;
    const timer = setTimeout(
      () => setFlagWaitExpired(true),
      HOST_TEMPLATE_FLAG_WAIT_MS,
    );
    return () => clearTimeout(timer);
  }, [requestedTemplateId]);

  useEffect(() => {
    if (!requestedTemplateId || !isAuthenticated || handledRef.current) return;
    // The template id is captured at mount, but this component stays mounted
    // across `/hosts` ↔ `/hosts/:hostId`. If the URL no longer asks for the
    // captured template — gone, emptied, or now naming a different one — the
    // link is stale: acting on it would create a host or bounce the user out of
    // the one they opened, and `replace: true` would eat the history entry that
    // leads back to it. Compared against the captured id rather than merely
    // tested for presence, so a template swapped mid-load can never resolve to
    // the host the user is no longer asking for.
    if (
      typeof window !== "undefined" &&
      new URLSearchParams(window.location.search).get(
        HOST_VERIFY_TEMPLATE_PARAM,
      ) !== requestedTemplateId
    ) {
      handledRef.current = true;
      return;
    }
    // Wait for the host list before deciding create-vs-open, and never mint a
    // host against an id `createHost` would reject. The projectId check is
    // stated here rather than left to `useHostList`'s loading flag: the two
    // are separate hooks, and a change to that flag's skip semantics must not
    // be able to let `createHost` fire with a not-yet-real project id.
    if (hostsLoading || !shouldQueryProjectId(projectId)) return;
    const template = HOST_TEMPLATES.find((t) => t.id === requestedTemplateId);
    if (!template) return;

    const existing = hosts.find((h) => h.name === template.label);
    if (existing) {
      handledRef.current = true;
      navigate(buildHostVerifyLandingPath(existing.hostId, requestedFocusTab), {
        replace: true,
      });
      return;
    }

    const templateEnabled = hostFeatureFlagState(requestedTemplateId, {
      claudeCode: claudeCodeEnabled,
      codex: codexEnabled,
    });
    // Gated templates remain visible on caniuse.dev as reference profiles, but
    // they are not available for new-host creation until their rollout flags
    // are enabled. Wait for PostHog before deciding so flagged users do not get
    // bounced during a cold load — but only until the deadline, so a relay that
    // never answers ends in the disabled path instead of a silent no-op.
    if (templateEnabled === undefined && !flagWaitExpired) return;
    if (!templateEnabled) {
      handledRef.current = true;
      navigate(routePaths.hosts, { replace: true });
      toast.error(`${template.label} is not available yet.`);
      return;
    }

    handledRef.current = true;

    void (async () => {
      try {
        const seed = cloneHostTemplateInput(
          seedFromHostTemplate(template.id, { theme: themeMode }),
          { themeMode },
        );
        const { hostId } = await createHost({
          projectId,
          name: template.label,
          input: { ...seed, serverIds: [] },
        });
        navigate(buildHostVerifyLandingPath(hostId, requestedFocusTab), {
          replace: true,
        });
      } catch (err) {
        // Leave the latch set. This effect also re-runs when the rollout flags
        // resolve, so releasing it here let a failed create fire again with no
        // user gesture — duplicating a host the first attempt may have
        // committed before it timed out. Retrying means opening the link again,
        // which remounts this hook and clears the latch.
        toast.error(
          err instanceof Error ? err.message : "Couldn't open that client",
        );
      }
    })();
  }, [
    requestedTemplateId,
    isAuthenticated,
    hostsLoading,
    hosts,
    projectId,
    requestedFocusTab,
    claudeCodeEnabled,
    codexEnabled,
    flagWaitExpired,
    themeMode,
    createHost,
    navigate,
  ]);
}

function buildHostVerifyLandingPath(
  hostId: string,
  tab: HostFocusTabId | null,
): string {
  const path = buildHostsPath(hostId);
  if (!tab) return path;
  const tabParam = hostFocusTabToVerifyParam(tab);
  if (!tabParam) return path;
  const params = new URLSearchParams({ [HOST_VERIFY_TAB_PARAM]: tabParam });
  return `${path}?${params.toString()}`;
}

/**
 * score.mcpjam.com's runner. Chrome-less and guest-first: the visitor mints a
 * guest session automatically, the server row lands in that guest's project,
 * and the whole thing is reachable with no sign-in.
 */
export function ScoreRunnerRoute() {
  const { convexProjectId } = useAppRouteContext();
  return <ScoreRunnerPage convexProjectId={convexProjectId ?? null} />;
}

/**
 * One stored run, addressable only by its secret link token. Reads through an
 * unauthenticated GET on purpose — a shared result must open in an incognito
 * window with no session, no guest cookie, and no project.
 */
export function ScoreResultsRoute() {
  return <ScoreResultsPage />;
}

/**
 * The Connector Bench runner, on the same chrome-less guest surface.
 *
 * Unlike the conformance runner it never executes anything in the browser: it
 * starts a hosted run and then reads it. The run id is a route param, so this
 * component holds no phase a reload could lose.
 */
export function BenchRunnerRoute() {
  const { convexProjectId } = useAppRouteContext();
  return <BenchRunnerPage convexProjectId={convexProjectId ?? null} />;
}

/**
 * One benchmark scorecard, addressable only by its secret link. Read through
 * an unauthenticated GET on purpose — a shared result must open with no
 * session, no guest cookie, and no project.
 */
export function BenchResultsRoute() {
  return <BenchResultsPage />;
}

export function HostCompareRoute({ bare = false }: { bare?: boolean } = {}) {
  const { convexProjectId, isAuthenticated } = useAppRouteContext();
  const [previewedHostId] = usePreviewedHostId(convexProjectId);
  const navigate = useAppNavigate();

  const compareView = (
    <HostConfigCompareView
      projectId={convexProjectId}
      isAuthenticated={isAuthenticated}
      presetOnly={bare}
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
          } else if (next === "skills") {
            navigate(routePaths.skills);
          }
        }}
        rightSlot={
          // Host/Compare sub-nav inline in the header row (single bar) rather
          // than stacked beneath the primary nav.
          <div className="flex min-w-0 flex-wrap items-center justify-center gap-2 @2xl:justify-end">
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

export function CaniuseCapabilityRoute() {
  const params = useParams<{ capabilitySlug?: string }>();
  return <CaniuseCapabilityPage capabilitySlug={params.capabilitySlug} />;
}

export function ComputerRoute() {
  const { convexProjectId, isAuthenticated, isGuestProjectActor } =
    useAppRouteContext();
  const [previewedHostId] = usePreviewedHostId(convexProjectId);
  const navigate = useAppNavigate();
  const computersEnabled = useComputersEnabledState();

  // A personal computer is account-scoped. Anonymous guests are provisioned
  // Convex actors (`isAuthenticated === true`), so member-ness — not raw auth —
  // decides whether there are peer tabs to switch to.
  //
  // Chrome only, and deliberately the eager form — same split as SkillsRoute:
  // it guesses member for the commit before `users:getCurrentUser` answers,
  // which for a member cold-load is the right guess.
  const isSignedInMember = isAuthenticated && !isGuestProjectActor;

  // The computer itself gets the ACTOR, tri-state and unflattened.
  //
  // `isGuestProjectActor` is `currentUser?.isAnonymous === true`, so it reads
  // `false` — "not a guest" — for the whole time that query is in flight. That
  // boolean is the skip argument for `projectComputers:getComputerStatus` two
  // components down (`ComputerView`'s `effectiveProjectId`), so passing it here
  // fires a member-only query as a guest and paints the member pane for them.
  // Flattening to `=== true` at this call site instead would fail closed on the
  // query and then tell a signed-in member to sign in, so the third state has
  // to survive the trip.
  const isMemberActor = useIsMemberActor();

  // Only redirect on an explicit `false`. While PostHog hydrates the flag is
  // `undefined`; bouncing then would strand a flagged-in user who cold-loads
  // /computer directly (the redirect fires before the flag resolves). Render
  // nothing until it settles — disabled users get the bounce a beat later.
  if (computersEnabled === false) {
    return <ScopedNavigate to={routePaths.servers} replace />;
  }
  if (computersEnabled === undefined) {
    return null;
  }

  const computerView = (
    <ComputerTabView
      projectId={convexProjectId}
      isSignedInMember={isMemberActor}
    />
  );

  if (!isSignedInMember) {
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
          } else if (next === "skills") {
            navigate(routePaths.skills);
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
          server={selectedServerEntry ?? undefined}
          serverConnectionStatus={
            selectedServerEntry?.connectionStatus ?? "disconnected"
          }
          tasksMode={taskModeForSurface(
            readTasksPolicy(activeHost?.config),
            "tools",
          )}
          mcpToolResultImageRendering={gateMcpToolResultImageRenderingByModelVisibility(
            activeHost?.config?.mcpToolResultImageRendering,
            activeHost?.config?.modelVisibleMcpToolResults,
          )}
        />
      </div>
    </ActiveHostCapsResolverScope>
  );
}

/**
 * Evaluate — one route, two lenses. Suites authors and runs eval suites;
 * Runs reviews what CI already produced. Both gate on the same `evals`
 * billing feature because they are one tab.
 */
export function EvalsRoute({ mode }: { mode?: EvalsMode } = {}) {
  const {
    billingUiEnabled,
    activeTabBillingLocked,
    activeTabBillingFeature,
    convexProjectId,
    ensureServersReady,
    handleContinueEvalInChat,
    handleConnect,
  } = useAppRouteContext();
  // The route table passes `mode` explicitly. The no-Router fallback body
  // (component tests) dispatches on the tab id alone, which is `evals` for
  // both lenses, so resolve from the URL when the prop is absent.
  const pathnameMode = useEvalsMode();
  const activeMode = mode ?? pathnameMode;

  if (billingUiEnabled && activeTabBillingLocked && activeTabBillingFeature) {
    return <ActiveBillingUpsellGate />;
  }

  if (activeMode === "runs") {
    return (
      <CiEvalsTab
        convexProjectId={convexProjectId}
        ensureServersReady={ensureServersReady}
      />
    );
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

/**
 * Evaluate (New) — the redesigned Evaluate tab, behind `evaluate-enabled`.
 *
 * A separate route rather than a branch inside `EvalsRoute` so the shipped tab
 * has no new conditional in it at all. Same `evals` billing feature: it is the
 * same product, only redrawn. No Runs lens — the commit-keyed CI review stays
 * on `/evals/runs`.
 */
export function EvaluateRoute() {
  const {
    billingUiEnabled,
    activeTabBillingLocked,
    activeTabBillingFeature,
    convexProjectId,
    ensureServersReady,
    handleContinueEvalInChat,
    handleConnect,
  } = useAppRouteContext();
  const evaluateEnabled = useEvaluateEnabledState();

  // The sidebar hides the nav item, but a nav filter is not a gate: `/evaluate`
  // is a plain route, and its `navSegments` entry feeds `KNOWN_APP_TAB_SEGMENTS`
  // so `ui_navigate` reaches it too. Bounce to the shipped tab — same product,
  // and the flagged-out user loses nothing by landing there.
  //
  // Only redirect on an explicit `false`. While PostHog hydrates the flag is
  // `undefined`; bouncing then would strand a flagged-in user who cold-loads
  // /evaluate directly. (Same tradeoff as SessionsRoute.)
  if (evaluateEnabled === false) {
    return <ScopedNavigate to={routePaths.evals} replace />;
  }
  if (evaluateEnabled === undefined) {
    return null;
  }

  if (billingUiEnabled && activeTabBillingLocked && activeTabBillingFeature) {
    return <ActiveBillingUpsellGate />;
  }

  return (
    <EvaluateTab
      projectId={convexProjectId}
      ensureServersReady={ensureServersReady}
      onContinueInChat={handleContinueEvalInChat}
      handleConnect={handleConnect}
    />
  );
}

export function ConformanceRoute() {
  const { selectedServerEntry, convexProjectId, isAuthenticated } =
    useAppRouteContext();
  const { serversByName } = useProjectServers({
    isAuthenticated,
    projectId: convexProjectId,
  });
  const savedServerId = selectedServerEntry?.name
    ? (serversByName.get(selectedServerEntry.name) ?? null)
    : null;
  return (
    <div className="flex h-full min-h-0 flex-col overflow-hidden">
      {convexProjectId ? (
        <div className="shrink-0 overflow-auto border-b border-border/40 px-4 pt-4 lg:px-6">
          <ConformanceHistory
            projectId={convexProjectId}
            serverId={savedServerId}
          />
        </div>
      ) : null}
      <div className="min-h-0 flex-1 overflow-hidden">
        <ConformanceTab
          server={selectedServerEntry ?? null}
          persist={
            convexProjectId
              ? { projectId: convexProjectId, serverId: savedServerId }
              : undefined
          }
        />
      </div>
    </div>
  );
}

export function ConformanceRunDetailRoute() {
  const { convexProjectId } = useAppRouteContext();
  const params = useParams<{ runId?: string }>();
  const pathname = getRouteFallbackPathname();
  const raw =
    params.runId ?? pathname.replace(/\/+$/, "").split("/").pop() ?? "";
  return (
    <ConformanceRunDetailPage
      runId={decodeParam(raw) ?? raw}
      projectId={convexProjectId}
    />
  );
}

export function ConformanceSharedRoute() {
  const params = useParams<{ token?: string }>();
  const pathname = getRouteFallbackPathname();
  const raw =
    params.token ?? pathname.replace(/\/+$/, "").split("/").pop() ?? "";
  return <ConformanceSharedPage token={decodeParam(raw) ?? raw} />;
}

export function EvalRunSharedRoute() {
  const params = useParams<{ token?: string }>();
  const pathname = getRouteFallbackPathname();
  const raw =
    params.token ?? pathname.replace(/\/+$/, "").split("/").pop() ?? "";
  return <EvalRunSharedPage token={decodeParam(raw) ?? raw} />;
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

// The User Testing surface: `/user-testing` (the project's scenarios) and
// `/user-testing/:scenarioId` (one scenario). Same billing feature and
// `sandboxes-enabled` flag as Swarms below.
export function ScenariosRoute() {
  const {
    billingUiEnabled,
    activeTabBillingLocked,
    activeTabBillingFeature,
    convexProjectId,
    isAuthenticated,
  } = useAppRouteContext();
  // The sidebar filters this item on the flag, but a filtered nav item is not
  // a gate — `/user-testing` is a plain route, so without this a direct URL
  // mounts the whole surface for users the flag excludes.
  const sandboxesEnabled = useSandboxesEnabledState();
  // Hooks first: every gate below early-returns, and a hook after one of them
  // would crash React the moment a gate settles between renders.
  const params = useParams<{ scenarioId?: string }>();

  // Only redirect on an explicit `false`. While PostHog hydrates the flag is
  // `undefined`, and bouncing then would strand a flagged-in user who cold-
  // loads the URL. (Same tradeoff SwarmsRoute makes.)
  if (sandboxesEnabled === false) {
    return <ScopedNavigate to={routePaths.servers} replace />;
  }
  if (sandboxesEnabled === undefined) {
    return null;
  }

  if (billingUiEnabled && activeTabBillingLocked && activeTabBillingFeature) {
    return <ActiveBillingUpsellGate />;
  }

  // Router params arrive decoded, but App also renders this component outside
  // a router (the legacy hash path), where `useParams` yields {} — fall back
  // to the pathname there. Deliberately NOT `useLocation`: that throws its
  // router invariant on the no-router path.
  const pathname = getRouteFallbackPathname();
  const rawScenarioId = params.scenarioId ?? scenarioIdFromPathname(pathname);
  // `new` is the create route, never a scenario id. The dedicated
  // `user-testing/new` route already keeps it out of `params.scenarioId`, but
  // reserving the word here means route-ordering can't quietly turn the create
  // page into a "Scenario not found".
  const scenarioId =
    rawScenarioId && rawScenarioId !== "new"
      ? decodeParam(rawScenarioId)
      : null;

  return (
    <UserTestingTab
      key={convexProjectId ?? "no-project"}
      projectId={convexProjectId}
      isAuthenticated={isAuthenticated}
      scenarioId={scenarioId}
      createOpen={isUserTestingCreatePath(pathname)}
      editOpen={isUserTestingEditPath(pathname)}
    />
  );
}

function isUserTestingCreatePath(pathname: string): boolean {
  return pathname.replace(/\/+$/, "") === "/user-testing/new";
}

function isUserTestingEditPath(pathname: string): boolean {
  return /^\/user-testing\/[^/]+\/edit$/.test(pathname.replace(/\/+$/, ""));
}

/**
 * The logical pathname for the no-Router fallbacks below.
 *
 * Project-relative: the User Testing matchers here are written against
 * `/user-testing/...`, and the live path carries `/p/<projectId>` in front of
 * it.
 */
function getRouteFallbackPathname(): string {
  return typeof window === "undefined"
    ? ""
    : stripProjectFromPath(window.location.pathname);
}

/**
 * `/user-testing/<id>` or `/user-testing/<id>/edit` → `<id>`.
 * `/user-testing/new` is the create route, not a scenario — it must never
 * reach the scenario query as an id.
 */
function scenarioIdFromPathname(pathname: string): string | null {
  const normalized = pathname.replace(/\/+$/, "");
  const editMatch = normalized.match(/^\/user-testing\/([^/]+)\/edit$/);
  if (editMatch?.[1] && editMatch[1] !== "new") return editMatch[1];
  const match = normalized.match(/^\/user-testing\/([^/]+)$/);
  const segment = match?.[1];
  if (!segment || segment === "new") return null;
  return segment;
}

function decodeParam(raw: string): string | null {
  try {
    const decoded = decodeURIComponent(raw);
    return decoded.trim() ? decoded : null;
  } catch {
    return raw.trim() ? raw : null;
  }
}

export function SwarmsRoute() {
  // Project-scoped Swarms surface (Persona → Journey → Run redesign) — no
  // longer a per-host scenario tab. Keeps the same billing gate as the scenario
  // product surface, and re-mounts per project so selection state can't leak
  // across a project switch.
  const {
    billingUiEnabled,
    activeTabBillingLocked,
    activeTabBillingFeature,
    convexProjectId,
    isAuthenticated,
  } = useAppRouteContext();
  // WorkOS identity is the membership match key for the *invitee guest*
  // notice. Convex `isAuthenticated` is also true for anonymous sessions,
  // which never get a WorkOS `user.email` — but those actors still own a
  // personal-org project and pass `requireProjectRole('member')` server-side
  // via userId. Do NOT treat "no WorkOS email" as "not a member".
  const { user, isLoading: isWorkOsLoading } = useAuth();
  const isWorkOsSignedIn = !!user;
  // The sidebar filters the Swarms nav item on this flag, but a filtered nav
  // item is not a gate — `/swarms` is a plain route, so a direct URL mounted
  // the whole surface for users the flag excludes.
  const sandboxesEnabled = useSandboxesEnabledState();

  // The backend made Swarm member-only vs project *invitee guests* (role
  // `guest`): personas/journeys/runs reject that tier. Mirror that for
  // WorkOS-signed-in viewers by resolving role from the members list.
  //
  // Anonymous Convex guests skip this notice and mount SwarmsTab — they are
  // owners of their personal-org default project. Unauthenticated local
  // (no `convexProjectId`) also keeps existing behavior.
  const roleGateActive =
    isAuthenticated && !!convexProjectId && isWorkOsSignedIn;
  const { role, isLoading: roleLoading } = useViewerProjectRole({
    isAuthenticated,
    projectId: convexProjectId,
    viewerEmail: user?.email,
    // Bound the "wait for email" window to WorkOS hydrate — not Convex auth —
    // so we never spin forever on anonymous sessions.
    identityLoading: isWorkOsLoading,
  });
  // Hook order: must run on EVERY render — the gates below early-return on
  // hydration states that flip between renders, and a hook after them would
  // crash React the moment a gate settles.
  const params = useParams<{ swarmId?: string }>();

  // Only redirect on an explicit `false`. While PostHog hydrates the flag is
  // `undefined`; bouncing then would strand a flagged-in user who cold-loads
  // /swarms directly. Render nothing until it settles. (Same tradeoff the
  // Environments route already makes.)
  if (sandboxesEnabled === false) {
    return <ScopedNavigate to={routePaths.servers} replace />;
  }
  if (sandboxesEnabled === undefined) {
    return null;
  }

  if (billingUiEnabled && activeTabBillingLocked && activeTabBillingFeature) {
    return <ActiveBillingUpsellGate />;
  }

  // Wait for WorkOS before choosing signed-in gate vs anonymous fallthrough,
  // so a real member never briefly mounts (or gets denied) mid-hydrate.
  if (isAuthenticated && !!convexProjectId && isWorkOsLoading) {
    return (
      <div className="flex h-full items-center justify-center">
        <Loader2 className="size-5 animate-spin text-muted-foreground" />
      </div>
    );
  }

  if (roleGateActive) {
    // Wait for members before deciding, so an invitee guest never briefly
    // mounts `SwarmsTab` (which would fire the member-only queries).
    if (roleLoading) {
      return (
        <div className="flex h-full items-center justify-center">
          <Loader2 className="size-5 animate-spin text-muted-foreground" />
        </div>
      );
    }

    if (!canViewSwarms(role)) {
      return (
        <EmptyState
          icon={Users}
          title="Swarms is available to project members"
          description="Personas, journeys, and their runs can only be viewed and run by project members. Ask a project admin to add you as a member to get access."
        />
      );
    }
  }

  const fallbackSwarmPathname =
    typeof window === "undefined"
      ? ""
      : stripProjectFromPath(window.location.pathname);
  const rawRouteSwarmId =
    params.swarmId ??
    (fallbackSwarmPathname.startsWith(`${routePaths.swarms}/`)
      ? fallbackSwarmPathname
          .slice(`${routePaths.swarms}/`.length)
          .split("/")[0]
      : null);
  // `/swarms/new` is the create route, not a run. The pathname fallback above
  // can't tell them apart on its own, and treating "new" as a swarmId would
  // render a not-found run detail instead of the create flow.
  const createFlow = rawRouteSwarmId === "new";
  const routeSwarmId = createFlow ? null : rawRouteSwarmId;
  let swarmId: string | null = null;
  if (routeSwarmId) {
    try {
      swarmId = decodeURIComponent(routeSwarmId);
    } catch {
      swarmId = routeSwarmId;
    }
  }

  return (
    <SwarmsTab
      key={convexProjectId ?? "no-project"}
      projectId={convexProjectId}
      isAuthenticated={isAuthenticated}
      swarmId={swarmId}
      createFlow={createFlow}
    />
  );
}

export function EnvironmentsRoute() {
  // Project environments (host + server group + skills bundles). The page
  // component itself enforces the `project-environments-enabled` flag —
  // rendering the standard redirect when off — so a direct `/environments`
  // URL cannot bypass the sidebar gate. Writes are project-admin only
  // (`canManageHosts` mirrors the backend's admin gate); everyone else
  // browses read-only.
  const { convexProjectId, isAuthenticated } = useAppRouteContext();
  // `/environments/:environmentId` — the exact permalink target. Same element
  // as `/environments`, so the param is what selects the detail.
  const { environmentId: routeEnvironmentId } = useParams<{
    environmentId?: string;
  }>();
  const { user, isLoading: isWorkOsLoading } = useAuth();
  const isWorkOsSignedIn = !!user;
  const { role } = useViewerProjectRole({
    isAuthenticated,
    projectId: convexProjectId,
    viewerEmail: user?.email,
    identityLoading: isWorkOsLoading,
  });
  // Shared with SwarmsTab and unit-tested in `useProjects.test.ts`: WorkOS
  // viewers take the role-based admin gate; a SETTLED anonymous Convex owner
  // gets management (they never receive a role); fail-closed while hydrating.
  const canManage = canManageAsOwnerOrAdmin({
    isWorkOsSignedIn,
    role,
    isAuthenticated,
    hasProject: !!convexProjectId,
    identityLoading: isWorkOsLoading,
  });
  return (
    <ProjectEnvironmentsRoute
      projectId={convexProjectId ?? null}
      canManage={canManage}
      isAuthenticated={isAuthenticated}
      routeEnvironmentId={routeEnvironmentId ?? null}
    />
  );
}

export function SessionsRoute() {
  // The cross-surface Sessions feed. Flag-gated while the backing backend
  // queries (`sessionsFeed:*`) roll out; row-level visibility (who sees whose
  // Playground sessions, swarm's member gate) is entirely server-side, so no
  // role gate here — the backend fail-softs a non-member to an empty page.
  const { convexProjectId } = useAppRouteContext();
  const unifiedSessionsEnabled = useUnifiedSessionsEnabledState();

  /**
   * A permalink names ONE exact session, and this feed is the only screen that
   * opens one: every `/v1/sessions` item carries `/sessions?session=<id>` as
   * its link, which the backend mints as the universal target for sessions
   * whose surface-native page does not exist (an eval Quick Run, a session
   * whose parent run was deleted). Nothing else in the app can render it.
   *
   * So the ROLLOUT flag must not swallow that link. It gates who DISCOVERS the
   * feed — the sidebar item, an unaddressed `/sessions` visit — not who may
   * read a session they were handed the id of, and bouncing a permalink to
   * Connect drops the id on the floor and lands the recipient on a screen they
   * never asked for, with nothing to say what happened. Row-level visibility
   * is entirely server-side (`canViewSessionInProject`), so honouring the link
   * exposes nothing the flag was protecting, and the dark-ship ErrorBoundary
   * below still covers a deployment whose feed queries are not live yet.
   */
  const permalinkSessionId = useCurrentSearchParam("session");

  // Only redirect on an explicit `false`. While PostHog hydrates the flag is
  // `undefined`; bouncing then would strand a flagged-in user who cold-loads
  // /sessions directly. (Same tradeoff as SwarmsRoute.)
  if (unifiedSessionsEnabled === false && !permalinkSessionId) {
    return <ScopedNavigate to={routePaths.servers} replace />;
  }
  if (unifiedSessionsEnabled === undefined) {
    return null;
  }

  if (!convexProjectId) {
    return (
      <EmptyState
        icon={MessageSquare}
        title="Sessions needs a project"
        description="Sign in and select a project to browse its sessions across Playground, User Testing, Evals, and Swarms."
      />
    );
  }

  return (
    // Dark-ship guard: `usePaginatedQuery` against a not-yet-deployed backend
    // query throws. Degrade to copy instead of white-screening the page.
    <ErrorBoundary
      name="sessions-panel"
      fallback={
        <EmptyState
          icon={MessageSquare}
          title="Sessions isn't available yet"
          description="This project's deployment doesn't serve the unified sessions feed yet. It becomes available with the next backend release."
        />
      }
    >
      <SessionsPanel key={convexProjectId} projectId={convexProjectId} />
    </ErrorBoundary>
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
        server={selectedServerEntry ?? undefined}
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
        server={selectedServerEntry ?? undefined}
        serverConnectionStatus={
          selectedServerEntry?.connectionStatus ?? "disconnected"
        }
      />
    </div>
  );
}

export function SkillsRoute() {
  const { convexProjectId, isAuthenticated, isGuestProjectActor, appState } =
    useAppRouteContext();
  const servers = appState?.servers as
    Record<string, ServerWithName> | undefined;
  // Names, in both modes. The local manager registers connections under their
  // name, and the hosted API layer resolves a name to its Convex server id
  // inside `buildServerRequest` — so resolving here too would duplicate that,
  // and the label must stay the name regardless: a server must never choose
  // the namespace its skills are addressed under.
  //
  // Memoized on a stable signature rather than rebuilt per render: the
  // consuming section fetches per connection, and a fresh array identity on
  // every render would restart those fetches indefinitely.
  const skillsMcpServers = useMemo(
    () =>
      Object.entries(servers ?? {}).map(([name, server]) => ({
        serverId: name,
        label: name,
        connected: server.connectionStatus === "connected",
      })),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [
      // JSON, not concatenation: a server NAME may contain the separators, so
      // `a|b` + `c` and `a` + `b|c` would key the same and the memo would hand
      // back a stale list for a genuinely different set of servers.
      JSON.stringify(
        Object.entries(servers ?? {}).map(([name, server]) => [
          name,
          server.connectionStatus,
        ]),
      ),
    ],
  );
  const [previewedHostId] = usePreviewedHostId(convexProjectId);
  const navigate = useAppNavigate();
  const skillsEnabled = useSkillsEnabledState();

  // Skills is a Servers-page view (Servers | Client | Computer | Skills), so
  // it renders the same chrome as its peers. Anonymous guests are provisioned
  // Convex actors (`isAuthenticated === true`), so member-ness — not raw auth —
  // decides whether there are peer tabs to switch to (mirrors ComputerRoute).
  //
  // Chrome only, and deliberately the eager form: it guesses member for the
  // commit before `users:getCurrentUser` answers, which for a member cold-load
  // is the right guess and avoids flashing the bare view under them. Guessing
  // wrong costs a guest one frame of peer tabs. The store's gate below cannot
  // use it — see there.
  const isSignedInMember = isAuthenticated && !isGuestProjectActor;

  // The actor Convex is holding, NOT `isSignedInMember`, for the store.
  //
  // `isGuestProjectActor` is `currentUser?.isAnonymous === true`, so while
  // `users:getCurrentUser` is in flight `undefined?.isAnonymous === true`
  // collapses to `false` — a guest reads as "not a guest" and
  // `isSignedInMember` is true. `isAuthenticated` flips true almost at once for
  // the pre-seeded guest bearer, so that window is real, and it is exactly the
  // window this gate must fail closed on. `useIsMemberActor` answers
  // `undefined` there rather than a wrong `true`, so `=== true` holds it shut
  // until Convex has said who the socket is carrying.
  const isMemberActor = useIsMemberActor();

  // The `skills-enabled` flag gates ONE HALF of this tab, not the tab.
  //
  // Hosted Cloud Skills are a project-MEMBERSHIP resource (authored in Convex,
  // available even without a Computer) still behind the flag until QA
  // completes, and enforced server-side too. Skills over MCP (SEP-2640) is a
  // different thing on the same page: a protocol capability served by whatever
  // the user connected, gated only by mutual declaration, whose
  // `/api/web/server-skills/*` routes carry no product flag. Redirecting the
  // whole route on the Cloud flag would hold the protocol half hostage to an
  // unrelated feature's rollout, so the flag is passed DOWN instead.
  //
  // The same flag also decides whether the local-mode Local/Cloud toggle is
  // offered, because that toggle browses the project store: gating it on
  // `computers-enabled` was a leftover from when cloud skills lived on a
  // Computer's filesystem. That is why the prop below is the flag itself and
  // not `!HOSTED_MODE || flag` — the old form read as "local mode always has
  // the store", which was harmless while the toggle carried its own gate and
  // becomes "no gate at all" the moment the toggle reads this prop instead.
  if (HOSTED_MODE && !convexProjectId) {
    // Wait for the project to resolve before rendering: hosted skills have no
    // local FS to fall back to, and the server-skills routes address their
    // connection by project.
    return null;
  }

  const skillsView = (
    <SkillsTab
      projectId={convexProjectId}
      // Skills over MCP (SEP-2640): the "From MCP servers" section reads its
      // catalog live, per connection, so it needs the CURRENT server list —
      // the label (host-assigned, from our registry) and whether the
      // connection is up. A disconnected server can't answer `skills/list`.
      mcpServers={skillsMcpServers}
      // `undefined` is PostHog still hydrating. Treated as off so the tab
      // renders its protocol half immediately and the Cloud store appears when
      // the flag resolves — content arriving is a better first paint than a
      // blank page for every user who only has the protocol half.
      //
      // AND the Convex actor, because the flag is not a proxy for member-ness:
      // a PostHog rollout is evaluated per distinct-id and resolves for
      // anonymous ones too, while the project store is a MEMBERSHIP resource
      // whose every Convex function is signed-in-only. Guests reach this tab by
      // design (see the bare-view branch below), so the flag alone offered them
      // a store they could only be refused from — a listing that fails and an
      // upload button whose mutation cannot land.
      cloudSkillsEnabled={skillsEnabled === true && isMemberActor === true}
    />
  );

  // Hosted guests keep the bare view (no peer Servers tabs to switch to) —
  // same posture as ComputerRoute. Local users ALWAYS get the Servers-page
  // chrome — the switcher is the only way back to Servers.
  if (HOSTED_MODE && !isSignedInMember) {
    return skillsView;
  }

  return (
    <motion.div
      key="skills"
      initial={{ opacity: 0, y: 8 }}
      animate={{ opacity: 1, y: 0 }}
      transition={SNAPPY_RAIL}
      className="flex h-full min-h-0 flex-col"
    >
      <ConnectViewHeader
        value="skills"
        previewedHostId={previewedHostId}
        onChange={(next) => {
          if (next === "servers") {
            navigate(routePaths.servers);
          } else if (next === "compare") {
            navigate(routePaths.hostCompare);
          } else if (next === "host" && previewedHostId) {
            navigate(buildHostsPath(previewedHostId));
          } else if (next === "computer") {
            navigate(routePaths.computer);
          }
        }}
      />
      <div className="min-h-0 flex-1">{skillsView}</div>
    </motion.div>
  );
}

export function LearningRoute() {
  const { activeProjectId } = useAppRouteContext();
  return <LearningTab projectId={activeProjectId ?? null} />;
}

export function TasksRoute() {
  const { selectedMCPConfig, appState } = useAppRouteContext();
  return (
    <div className="h-full overflow-hidden">
      <TasksTab
        serverConfig={selectedMCPConfig}
        serverName={appState.selectedServer}
        isActive
        connectionStatus={
          appState.servers[appState.selectedServer]?.connectionStatus
        }
      />
    </div>
  );
}

export function OAuthFlowRoute() {
  const {
    appState,
    displayServerConfigs,
    areServersHydrated,
    setSelectedServer,
    saveServerConfigWithoutConnecting,
    handleConnectWithTokensFromOAuthFlow,
    handleRefreshTokensFromOAuthFlow,
    oauthServerModalNonce,
    oauthDebuggerHasHeaderServers,
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
                  {redactOAuthDebuggerError(error).message}
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
        const sanitizedError = redactOAuthDebuggerError(error);
        track("oauth_debugger_error_boundary", {
          location: "oauth_flow",
          name: sanitizedError.name,
          message: sanitizedError.message,
          stack: sanitizedError.stack,
          componentStack: redactStackLikeText(errorInfo.componentStack),
        });
      }}
    >
      <OAuthFlowTab
        serverConfigs={displayServerConfigs}
        selectedServerName={appState.selectedServer}
        hasHeaderServers={oauthDebuggerHasHeaderServers}
        areServersHydrated={areServersHydrated}
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
    areServersHydrated,
    activeOrganizationId,
    activeProject,
    convexProjectId,
    setSelectedServer,
    saveServerConfigWithoutConnecting,
    xaaServerModalNonce,
    xaaDebuggerHasHeaderServers,
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
        hasHeaderServers={xaaDebuggerHasHeaderServers}
        areServersHydrated={areServersHydrated}
        organizationId={activeOrganizationId ?? null}
        projectId={convexProjectId ?? null}
        projectXaaTestDefaults={activeProject?.xaaTestDefaults ?? null}
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

export function WebmcpInspectorRoute() {
  const webmcpEnabled = useWebmcpInspectorEnabledState();

  // Only redirect on an explicit `false`. While PostHog hydrates the flag is
  // `undefined`, and bouncing then would strand a flagged-in user who
  // cold-loads /webmcp directly — the same hydration race `ComputerRoute`
  // guards against.
  if (webmcpEnabled === false) {
    return <ScopedNavigate to={routePaths.servers} replace />;
  }
  if (webmcpEnabled === undefined) {
    return null;
  }
  return <WebmcpInspectorTab />;
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
    isClientConfigSyncPending,
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
      isClientConfigSyncPending={isClientConfigSyncPending}
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
          current?.id === id ? null : current,
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

export function IntegrationsSettingsRoute() {
  const { activeOrganizationId } = useAppRouteContext();
  // No boundary around the page itself: the only query that can throw here is
  // GitHub availability, and `IntegrationsRoute` already wraps that card in its
  // own boundary so a GitHub-side failure hides one card instead of the page.
  // Slack has to stay reachable regardless.
  return <IntegrationsRoute activeOrganizationId={activeOrganizationId} />;
}

export function GithubChecksSettingsRoute() {
  const { activeOrganizationId } = useAppRouteContext();
  // The page's queries THROW rather than resolve when the backend cannot answer
  // — the function is not deployed yet, or the caller is not a member of the
  // active org (the backend throws there on purpose; `disabled` would confirm
  // the org exists). Without a boundary that unmounts the whole app.
  //
  // Redirecting matches what an explicit `disabled` already does: a gated
  // surface that cannot confirm it is available is not available. The error is
  // logged rather than swallowed, so a genuine render bug is still visible.
  return (
    <ErrorBoundary
      onError={(error) =>
        console.error("[settings/integrations/github] unavailable:", error)
      }
      fallback={<Navigate to="/settings" replace />}
    >
      <GithubChecksRoute activeOrganizationId={activeOrganizationId} />
    </ErrorBoundary>
  );
}

/**
 * `/settings/integrations/github/callback` — GitHub's return path, both legs.
 *
 * Same `ErrorBoundary` doctrine as the settings page: this page's actions THROW
 * when the backend cannot answer (not deployed yet, or the caller is not a
 * member), and without a boundary that unmounts the whole app. It redirects to
 * `/settings` for the same reason too — a gated surface that cannot confirm it
 * is available is not available.
 *
 * No `activeOrganizationId` is passed, and none is needed: the browser arrives
 * back from GitHub carrying only query parameters, and which organization the
 * binding belongs to is recovered server-side from the link session. A page
 * that read it from app state could disagree with the session and would then be
 * asserting an organization nobody proved anything about.
 */
export function GithubInstallCallbackSettingsRoute() {
  return (
    <ErrorBoundary
      onError={(error) =>
        console.error(
          "[settings/integrations/github/callback] unavailable:",
          error,
        )
      }
      fallback={<Navigate to="/settings" replace />}
    >
      <GithubInstallCallbackRoute />
    </ErrorBoundary>
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
  // Forward the query string: `/chat?conversation=<id>` is what an OAuth return
  // marker or an old bookmark can still carry, and dropping the search here
  // would land the user on an empty Playground with the id already gone.
  //
  // Scoped to the project the alias was reached IN: `<Navigate to="/playground">`
  // would leave the project sub-tree, land on the unscoped legacy route, and
  // re-resolve the project from persisted state — an extra redirect that can
  // arrive at a DIFFERENT project than the link named.
  const { pathname, search } = useCurrentLocationParts();
  return (
    <Navigate
      to={scopeNavigationTarget(`${routePaths.playground}${search}`, pathname)}
      replace
    />
  );
}

export function ServersRedirectRoute() {
  return <ScopedNavigate to={routePaths.servers} replace />;
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
  const billingEntitlementsUiEnabled = useFeatureFlagEnabled(
    "billing-entitlements-ui",
  );
  const learningEnabled = useFeatureFlagEnabled("mcpjam-learning");
  const registryEnabled = useFeatureFlagEnabled("registry-enabled");
  const conformanceEnabled = useFeatureFlagEnabled("mcpjam-conformance");
  const compatibilityEnabled = useFeatureFlagEnabled("mcpjam-compatibility");
  const xaaEnabled = useFeatureFlagEnabled("xaa");

  // Per-tab "hide from this header" list for the OAuth / XAA debugger chip strip.
  // View-only (localStorage) — the x on a chip dismisses it from this header
  // without touching the server's config, tokens, or Convex row.
  const headerHiddenSurface: HeaderSurface | null =
    activeTab === "oauth-flow"
      ? "oauth"
      : activeTab === "xaa-flow" && xaaEnabled === true
        ? "xaa"
        : null;
  const { hidden: hiddenHeaderServers, hide: hideHeaderServer } =
    useHiddenHeaderServers(headerHiddenSurface);

  const {
    getAccessToken,
    signIn,
    user: workOsUser,
    isLoading: isWorkOsLoading,
  } = useAuth();
  const { isAuthenticated, isLoading: isAuthLoading } = useConvexAuth();
  const actorKey = useActorKey();
  const currentUser = useQuery(
    "users:getCurrentUser" as any,
    isAuthenticated ? ({} as any) : "skip",
  );
  // Keyed off the stored callback context rather than the platform: the
  // scenario runtime (and its OAuth flows) runs on local/desktop builds too,
  // and the completion effect below is already context-gated.
  const [hostedOAuthHandling, setHostedOAuthHandling] = useState(() => {
    const callbackContext = getHostedOAuthCallbackContext();
    return callbackContext != null && callbackContext.surface !== "project";
  });
  const [exitedScenarioChat, setExitedScenarioChat] = useState(false);
  // The published-scenario runtime route (`/user-testing/<slug>/<token>`, plus the
  // sessionStorage fallback that survives the post-redeem token strip) is
  // platform-uniform: it resolves on hosted, local, and desktop builds
  // alike. Capability gating happens downstream — redeem failures surface
  // through ScenarioChatPage's error states — so local dev gets the same
  // share-link and Preview-pane behavior as production.
  const scenarioPathToken = getScenarioPathTokenFromLocation();
  const scenarioSession = readScenarioSession();
  const hostedRouteKind = useMemo(() => {
    if (scenarioPathToken) {
      return "scenario" as const;
    }

    if (scenarioSession) {
      return "scenario" as const;
    }

    return null;
  }, [scenarioPathToken, scenarioSession]);
  const isScenarioChatRoute =
    !exitedScenarioChat && hostedRouteKind === "scenario";

  // Chrome-less vanity surfaces (caniuse.dev, score.mcpjam.com): render
  // full-bleed without the sidebar/header, and suppress first-run onboarding
  // so a visitor lands on the thing they came for. `router.tsx` alone is not
  // enough — without this branch the score page would render inside the app
  // shell, behind the NUX redirect a guest has never seen.
  //
  // Compared with the trailing slash normalized away: the router matches
  // `/embed/score/` as happily as `/embed/score`, so an exact compare would let
  // a hand-typed or link-appended slash render this guest surface inside the
  // full shell — with the onboarding redirect live.
  const barePathname =
    window.location.pathname.length > 1
      ? window.location.pathname.replace(/\/+$/, "")
      : window.location.pathname;
  const isBareCaniuseRoute =
    barePathname === routePaths.embedHostCompare ||
    barePathname === routePaths.embedScore ||
    barePathname === routePaths.embedBench ||
    // `/embed/bench/<runId>` is the same chrome-less screen resumed, so the
    // deep link has to clear the shell and the NUX redirect too — otherwise
    // reloading a running benchmark drops the visitor into onboarding.
    barePathname.startsWith(`${routePaths.embedBench}/`) ||
    barePathname.startsWith(`${routePaths.benchResults}/`) ||
    barePathname.startsWith(`${routePaths.scoreResults}/`) ||
    barePathname.startsWith(`${routePaths.conformanceShared}/`) ||
    barePathname.startsWith(`${routePaths.evalsShared}/`) ||
    barePathname.startsWith(`${routePaths.capabilities}/`);
  // The WorkOS Initiate Login URL, where an IdP-initiated login (the Okta app
  // tile) is parked for the instant it takes `LoginInitiationRoute` to start a
  // fresh sign-in. `/login` is not a known tab segment, so it resolves to the
  // `servers` fallback — which is a first-run-eligible route, and a hosted
  // guest session is Convex-authenticated. Without this the onboarding redirect
  // below can fire on the very commit that mounts the route and navigate the
  // visitor to Playground mid-sign-in, stranding exactly the enterprise entry
  // point this route exists to fix.
  const isLoginInitiationRoute = barePathname === routePaths.login;

  const defaultHubRoute = useMemo((): "home" | "connect" | "servers" => {
    return "home";
  }, []);
  const isHostedChatRoute = isScenarioChatRoute;
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
        sortedOrganizations.some((org) => org._id === organizationId),
      );
      return nextIds.length === currentIds.length &&
        nextIds.every(
          (organizationId, index) => organizationId === currentIds[index],
        )
        ? currentIds
        : nextIds;
    });
  }, [isLoadingOrganizations, sortedOrganizations]);
  const effectiveOrganizations = useMemo(
    () =>
      sortedOrganizations.filter(
        (organization) =>
          !optimisticallyDeletedOrganizationIds.includes(organization._id),
      ),
    [optimisticallyDeletedOrganizationIds, sortedOrganizations],
  );
  // Orgs the user may actually open. A `seatPending` org is a paid-seat invite
  // whose membership hasn't linked yet, so every org-scoped query for it is
  // denied server-side — making it active crashed the route
  // (Sentry INSPECTOR-CLIENT-24C). It stays in `effectiveOrganizations` so the
  // switcher can list it as unavailable, but it must never become the
  // active org, by route or by fallback.
  const selectableOrganizations = useMemo(
    () => effectiveOrganizations.filter((org) => !org.seatPending),
    [effectiveOrganizations],
  );
  const hasRouteOrganization = !!routeOrganizationId
    ? selectableOrganizations.some((org) => org._id === routeOrganizationId)
    : false;

  // Handle hosted OAuth callback: claim the callback before any hosted page renders.
  useEffect(() => {
    // Wait for Convex/WorkOS auth to settle before deciding signed-in vs guest
    // bearer. On post-redirect mount the first render sees
    // isAuthenticated=false while isAuthLoading=true; routing a signed-in
    // user's completion through the guest-bearer branch materializes a fresh
    // anonymous user with no scenarioAccess row and 403s on
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
    // 2R-iss: RFC 9207 issuer identification from the callback URL.
    const iss = urlParams.get("iss");

    let cancelled = false;
    setHostedOAuthHandling(true);

    const finalizeHostedOAuth = (errorMessage?: string | null) => {
      if (cancelled) return;
      if (errorMessage && callbackContext.serverName) {
        markPendingChatScopeStepUpCancelled(
          callbackContext.serverName,
          errorMessage,
        );
      }
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
      localStorage.removeItem(OAUTH_PENDING_STORAGE_KEY);
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
    const isGuestScenarioSessionCallback =
      !isAuthenticated &&
      !!callbackContext.scenarioId &&
      !!callbackContext.sessionId;
    // score.mcpjam.com: a guest authorizing a server in their OWN guest
    // project. There is no scenario here, so the scenario branch above can never
    // match — but the completion is otherwise identical, and without this the
    // callback would fall through to the legacy client-side token exchange,
    // which has no hosted server context to exchange against.
    const isGuestScoreCallback =
      !isAuthenticated &&
      callbackContext.surface === "score" &&
      hasHostedServerContext;
    const shouldUseHostedCompletion =
      hasHostedServerContext &&
      (isAuthenticated ||
        isGuestScenarioSessionCallback ||
        isGuestScoreCallback);

    const completeCallback = shouldUseHostedCompletion
      ? (async () => {
          let authorizationHeader: string | undefined;
          if (isGuestScenarioSessionCallback || isGuestScoreCallback) {
            const guestBearerToken = await getGuestBearerToken();
            if (!guestBearerToken) {
              return {
                success: false,
                error: isGuestScoreCallback
                  ? "Your session expired while you were authorizing. Start the scan again."
                  : "Your guest session expired. Reopen the swarm link and try again.",
              };
            }
            authorizationHeader = `Bearer ${guestBearerToken}`;
          } else if (workOsUser) {
            // On scenario routes, `useApiContext` is disabled (App.tsx
            // `enabled: !isHostedChatRoute`), so the module-level apiContext
            // is EMPTY_CONTEXT. authFetch's default header resolver then sees
            // `!apiContext.isAuthenticated && !apiContext.hasSession`, decides
            // the actor is a guest, and attaches a guest bearer — even though
            // the user is WorkOS-signed-in. The backend then materializes a
            // fresh anonymous user and 403s on scenarioAccess lookup. Explicitly
            // attach the WorkOS bearer here so the scenario-route gating of
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
            callbackIss: iss,
            onTraceUpdate: handleLiveOAuthTrace,
            authorizationHeader,
          });
        })()
      : handleOAuthCallback(code, {
          onTraceUpdate: handleLiveOAuthTrace,
          callbackState: state,
          callbackIss: iss,
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
  }, [isAuthLoading, isAuthenticated, workOsUser, getAccessToken]);

  usePostHogIdentify();
  // Stops replay while on `/results/<token>` — the init-time
  // `disable_session_recording` flag cannot cover in-app navigation into it.
  useSessionRecordingPathGuard();

  const lastLaunchedActorRef = useRef<string | null>(null);
  useEffect(() => {
    if (!actorKey) return;
    if (lastLaunchedActorRef.current === actorKey) return;
    lastLaunchedActorRef.current = actorKey;
    track("app_launched", {
      location: "app",
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

  const isDebugCallback = isDebugOAuthCallbackPath(window.location.pathname);
  const isOAuthCallback = window.location.pathname === "/callback";
  const isMcpOAuthCallback = window.location.pathname === "/oauth/callback";
  // Project callbacks are completed by `useServerState`, which has its own
  // project-aware restoration path. The App-level hosted flow intentionally
  // excludes them, so its loading gate must too; otherwise this callback can
  // remain on a blank screen while that hook performs the exchange.
  const isProjectMcpOAuthCallback =
    isMcpOAuthCallback &&
    getHostedOAuthCallbackContext()?.surface === "project";
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
      const scenarioReturnPath = readScenarioSignInReturnPath();
      const persistedCheckoutIntent = readPersistedCheckoutIntent();
      const billingReturnPath = persistedCheckoutIntent
        ? readBillingSignInReturnPath()
        : null;
      const cliReturnPath = readCliSignInReturnPath();
      const apiKeysReturnPath = readApiKeysSignInReturnPath();
      // Consumed (read AND cleared) whether or not it wins: a path left in
      // storage would outlive this sign-in and hijack the next one.
      const appReturnPath = consumeAppSignInReturnPath();
      clearScenarioSignInReturnPath();
      clearBillingSignInReturnPath();
      clearCliSignInReturnPath();
      clearApiKeysSignInReturnPath();
      // LAST in precedence, deliberately. The scenario, billing, CLI and
      // API-key flows encode an intent, not just a location, and each has its
      // own documented ordering; the generic path only says "put me back", so
      // it fills in for the ordinary case those four do not cover.
      const restoredPath =
        scenarioReturnPath ??
        billingReturnPath ??
        cliReturnPath ??
        apiKeysReturnPath ??
        appReturnPath ??
        "/";
      trackSignInReturnRestored(
        !appReturnPath
          ? "absent"
          : restoredPath === appReturnPath
            ? "restored"
            : "superseded",
      );
      // `navigateApp`, not `history.replaceState`: a raw history write leaves
      // the ROUTER matched on `/callback` while the address bar says
      // `/p/<id>/evals/...`, so the project boundary never mounts and the URL
      // that was just restored decides nothing. This is what makes the
      // complete canonical URL survive the round trip.
      navigateApp(restoredPath, { replace: true });
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
    ensureHostedServerIdsForNames,
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
    // Connect-screen inspector commands (`ui_add_server` & co) delegate to
    // these — the same handles the Connect screen's own buttons use.
    connectServerWithResult,
    handleDisconnect: handleDisconnectAction,
    handleRemoveServer: handleRemoveServerAction,
    activeMcpProfile,
    activeHost,
    activeHostId,
    setActiveHostId,
  } = useAppState({
    currentUserId: workOsUser?.id ?? null,
    currentActorKey: actorKey,
    hasOrganizations: selectableOrganizations.length > 0,
    isLoadingOrganizations,
    validOrganizations: selectableOrganizations,
    routeOrganizationId: hasRouteOrganization ? routeOrganizationId : undefined,
    requestSignIn: () => {
      // Ordinary app sign-in: remember the whole current URL — project
      // segment, query and hash included — so the round trip through WorkOS
      // returns to the exact page, not to the app's front door.
      captureAppSignInReturnPath();
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
        serverNames.map((serverName) => handleDisconnect(serverName)),
      ),
      disconnectAllRuntimeServers(),
    ]);
    let timeoutId: number | undefined;
    const timeoutPromise = new Promise<void>((resolve) => {
      timeoutId = window.setTimeout(
        resolve,
        AUTH_EXIT_RUNTIME_CLEANUP_TIMEOUT_MS,
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
  const handleInspectorScopeStepUp = useCallback(
    (event: {
      serverId: string;
      requiredScope?: string;
      resourceMetadataUrl?: string;
    }) => {
      const server = resolveScopeStepUpServer(appState, {
        serverId: event.serverId,
      });
      // The harness delivers a turn's 403 out-of-band, but it is still a CHAT
      // step-up: redirecting here while the turn streams loses the transcript
      // just the same. Same queue as the stream-part channel, so whichever of
      // the two arrives second is deduped rather than doubling the redirect.
      // Outside a turn this is exactly `driveScopeStepUp`.
      driveChatScopeStepUp(server, {
        requiredScope: event.requiredScope,
        resourceMetadataUrl: event.resourceMetadataUrl,
      });
    },
    [appState],
  );
  useInspectorCommandBus({ onScopeStepUp: handleInspectorScopeStepUp });
  // MCPJam UI tools: registered in both modes for the in-app "Ask MCPJam"
  // agent (the registry's only consumer); the always-available side panel
  // drives whichever inspector surface is open, so registration lives at the
  // App root. Never exposed to browser-native agents. Disabled on the
  // standalone scenario chat route: its end user is not the inspector
  // operator, so inspector-driving tools must not exist on that page.
  useRegisterUiTools({ enabled: !isScenarioChatRoute });
  // One-time migration from legacy localStorage state to Convex. No-op in
  // hosted mode and after the first successful run; safe to keep in the tree.
  useLocalStateMigration({
    isAuthenticated,
    isUserBootstrapping: isAuthenticated && !isUserReady,
    organizationId: activeOrganizationId,
  });
  usePostHogOrgContext(activeOrganizationId);
  useSentryOrgContext(activeOrganizationId);
  const oauthDebuggerServersRef = useRef(appState.servers);
  oauthDebuggerServersRef.current = appState.servers;
  const projectServersRef = useRef(projectServers);
  projectServersRef.current = projectServers;
  const selectedServerRef = useRef(appState.selectedServer);
  selectedServerRef.current = appState.selectedServer;
  // Publish the current selection for the agent's per-turn orientation block,
  // which is built in a hook that can't reach app state (ui-context-source).
  // `selectedServer` uses the string "none" as its no-selection sentinel —
  // excluded here so the model isn't told a server literally named "none" is
  // selected.
  useEffect(() => {
    const names = appState.selectedMultipleServers.length
      ? appState.selectedMultipleServers
      : appState.selectedServer && appState.selectedServer !== "none"
        ? [appState.selectedServer]
        : [];
    publishSelectedServerNames(names);
  }, [appState.selectedMultipleServers, appState.selectedServer]);
  const persistRuntimeServerToProjectRef = useRef(
    persistRuntimeServerToProjectIfNeeded,
  );
  persistRuntimeServerToProjectRef.current =
    persistRuntimeServerToProjectIfNeeded;
  // Action-layer handles for the Connect-screen inspector commands. Refs,
  // like the ones above, so the handler-registration effect doesn't tear
  // down and re-register on every render these identities change.
  const connectServerWithResultRef = useRef(connectServerWithResult);
  connectServerWithResultRef.current = connectServerWithResult;
  const handleDisconnectRef = useRef(handleDisconnectAction);
  handleDisconnectRef.current = handleDisconnectAction;
  const handleRemoveServerRef = useRef(handleRemoveServerAction);
  handleRemoveServerRef.current = handleRemoveServerAction;
  const getInspectorServerState = useCallback((serverName: string) => {
    const runtimeServer = oauthDebuggerServersRef.current[serverName];
    const projectServer = projectServersRef.current[serverName];
    const server = runtimeServer ?? projectServer;
    return server ? { runtimeServer, projectServer, server } : null;
  }, []);
  useEffect(() => {
    return subscribeToOAuthDebuggerRequests(({ serverName }) => {
      const matchedServerName = Object.entries(
        oauthDebuggerServersRef.current,
      ).find(
        ([name, server]) => name === serverName || server.name === serverName,
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
    (org) => org._id === activeOrganizationId,
  )?.name;
  const hostedShellGateState = resolveHostedShellGateState({
    hostedMode: HOSTED_MODE,
    isConvexAuthLoading: isAuthLoading,
    isConvexAuthenticated: isAuthenticated,
    isWorkOsLoading,
    hasWorkOsUser: !!workOsUser,
  });
  const baseHostedShellGateState = hostedShellGateState;
  const pendingDashboardOAuthServer = pendingDashboardOAuth
    ? projectServers[pendingDashboardOAuth.serverName]
    : null;
  const shouldShowPendingDashboardOAuthGate =
    !!pendingDashboardOAuth && !pendingDashboardOAuthServer;
  const effectiveHostedShellGateState = shouldShowPendingDashboardOAuthGate
    ? "project-loading"
    : baseHostedShellGateState;
  const pendingDashboardOAuthMessage = pendingDashboardOAuth
    ? `Finishing OAuth sign-in for ${pendingDashboardOAuth.serverName}...`
    : undefined;
  const hasAnyFirstRunBlockingProjectServers = Object.keys(projectServers).some(
    (serverName) => serverName !== EXCALIDRAW_SERVER_NAME,
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
  // A "Verify against your server" deep-link (`/hosts?template=claude`) must
  // reach HostsRoute so it can open/create that client's host. Without this
  // guard the first-run onboarding redirect below fires on the fresh load and
  // navigates to Playground, dropping the `?template` param before it's handled.
  // Only a *known* template id suppresses onboarding — an unknown/stale value
  // (e.g. `?template=bogus` from an old link) is never consumed by the deep-link
  // handler, so treating it as a real deep-link would strand new users on an
  // empty surface with onboarding silently disabled.
  const hasHostTemplateVerifyParam =
    typeof window !== "undefined" &&
    (() => {
      const raw = new URLSearchParams(window.location.search).get("template");
      return raw != null && HOST_TEMPLATES.some((t) => t.id === raw);
    })();
  // Same clobber hazard for a project-bearing entry — either shape. The
  // onboarding redirect would drop the path before it is normalized onto
  // `/p/<projectId>/...`, taking the destination the link named with it.
  //
  // The path test asks whether the URL CLAIMS a project, not whether that
  // claim is usable: `/p/<malformed>/servers` matches the `p/:projectId`
  // route, and the boundary answers it with the generic inaccessible state.
  // Testing for a well-formed id instead would let the onboarding redirect
  // fire on exactly those URLs and replace the error with Playground — the
  // requested URL gone, and no way to tell the user what was wrong with it.
  //
  // A legacy `?project=` still counts only when it is USABLE: that one is
  // stripped rather than reported, so a malformed value must not suppress
  // onboarding. Either way the suppression is transient — the normalizer
  // resolves or gives up on the first render after project data settles.
  const hasProjectSwitchDeepLinkParam =
    typeof window !== "undefined" &&
    (hasProjectDeepLinkParam(window.location.search) ||
      readProjectPathSegment(window.location.pathname) !== null);
  const shouldRouteToFirstRunOnboarding =
    !isHostedChatRoute &&
    !isBareCaniuseRoute &&
    !isLoginInitiationRoute &&
    !hasHostTemplateVerifyParam &&
    !hasProjectSwitchDeepLinkParam &&
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
      isNewSignedInAccount,
    );
  const shouldHoldHostedHomeRouteForFirstRunRedirect =
    HOSTED_MODE && activeTab === "home" && shouldRouteToFirstRunOnboarding;

  const previousConnectedServersRef = useRef<Set<string> | null>(null);
  useEffect(() => {
    const connectedServers = new Set(
      Object.entries<ServerWithName>(appState.servers)
        .filter(([, server]) => server.connectionStatus === "connected")
        .map(([name]) => name),
    );

    const previousConnectedServers = previousConnectedServersRef.current;
    const newlyConnectedServers = getNewlyConnectedServers(
      previousConnectedServers,
      connectedServers,
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
      activeTab === "playground" ||
      activeTab === "tools" ||
      activeTab === "resources" ||
      activeTab === "prompts" ||
      activeTab === "tasks" ||
      activeTab === "conformance" ||
      activeTab === "compatibility";
    if (!needsServer || selectedMCPConfig) return;

    const firstConnected = Object.entries(projectServers).find(
      ([, server]) => (server as any).connectionStatus === "connected",
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
    [appState, projects, activeProjectId],
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
  // Memoized because this feeds `useApiContext`'s dependency array. Computing
  // it inline returned a fresh object on every render whenever the host had
  // not hydrated capabilities — i.e. whenever a server was failing to connect —
  // which closed a render-speed refetch loop on /api/web/tools/list. See the
  // hook for the full chain.
  const hostedClientCapabilities = useHostedClientCapabilities(
    activeHost?.clientCapabilities,
    activeProject?.clientConfig,
  );
  const convexProjectId = activeProject?.sharedProjectId ?? null;
  const canQueryProjectServerConfig = isUserReady && Boolean(convexProjectId);
  const projectServerConfigDto = useQuery(
    "projectServerConfig:getConfig" as never,
    canQueryProjectServerConfig
      ? ({ projectId: convexProjectId } as never)
      : "skip",
  ) as ProjectServerConfigDto | null | undefined;
  // A skipped query reads as `undefined`, so this already covers the window
  // where `canQueryProjectServerConfig` is false for a project-scoped session.
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
    ? (routeOrganizationId ?? null)
    : null;
  const rawBillingOrganizationId =
    routeScopedOrganizationId ??
    activeOrganizationId ??
    activeProject?.organizationId ??
    null;
  const billingOrganizationId =
    !isLoadingOrganizations &&
    rawBillingOrganizationId &&
    selectableOrganizations.some((org) => org._id === rawBillingOrganizationId)
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
    activeTabGate,
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
    for (const key of ["evals", "scenarios"] as const) {
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
        : (projectCreationGate.denialMessage ?? undefined);
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

  // Fetch project servers to map server IDs to names
  const { serversById } = useProjectServers({
    isAuthenticated,
    projectId: convexProjectId,
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
            (v): v is string => typeof v === "string" && v.trim() !== "",
          )
        : undefined;

    const rawHostPin = activeMcpProfile?.mcpProtocolVersion;
    const hostPin: McpProtocolVersion | undefined =
      typeof rawHostPin === "string" && isKnownProtocolVersion(rawHostPin)
        ? rawHostPin
        : undefined;

    const mcpProtocolVersionsByServerId: Record<string, McpProtocolVersion> =
      {};
    const seenServerIds = new Set<string>();
    for (const [serverName, serverId] of Object.entries(
      hostedServerIdsByName,
    )) {
      if (seenServerIds.has(serverId)) continue;
      seenServerIds.add(serverId);
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
      // Share the client resolver's precedence so hosted chat/eval pick up the
      // 2026 wire era a server carries via its OAuth profile / stamped config —
      // not just explicit per-server overrides. Otherwise a modal-saved 2026
      // OAuth server passes the immediate probe but hosted backend connects
      // fall back to the 2025 initialize path. (`override → config pin →
      // OAuth-profile 2026 → host default`.)
      const effective = resolveEffectiveWireProtocolVersion({
        serverConfig: undefined,
        server: appState.servers[serverName],
        serverOverride,
        hostPin,
      });
      if (!effective) continue;
      mcpProtocolVersionsByServerId[serverId] = effective;
    }

    // Enterprise-managed authorization policy — sent only when validly ON.
    // An `invalid` stored value is NOT silently dropped to off: host-bound
    // turns hit the server-authoritative 409, and interactive connects
    // fail in buildResolverConnectionDefaults with an actionable message.
    const xaaPolicyState = readXaaEnterprisePolicy(activeMcpProfile);
    const xaaPolicy =
      xaaPolicyState.kind === "on" ? xaaPolicyState.policy : undefined;

    // SEP-2243 mirroring. Host-level, so there is no per-server map to build:
    // only `"omit"` reaches the wire, as `false`.
    const mirrorToolParamHeaders =
      activeMcpProfile?.toolParamHeaderMirroring === "omit" ? false : undefined;
    // Sibling conformance knobs — same host-level shape, only the non-default
    // value reaches the wire.
    const firstPageOnly =
      activeMcpProfile?.paginationTraversal === "firstPageOnly"
        ? (true as const)
        : undefined;
    const supportsMrtr =
      activeMcpProfile?.mrtrSupport === "none" ? (false as const) : undefined;
    const suppressListenChannel =
      activeMcpProfile?.toolListChanged?.listens === false
        ? (true as const)
        : undefined;
    const dropToolListChanged =
      activeMcpProfile?.toolListChanged?.refetches === false
        ? (true as const)
        : undefined;

    return {
      clientInfo,
      supportedProtocolVersions,
      mcpProtocolVersionsByServerId:
        Object.keys(mcpProtocolVersionsByServerId).length > 0
          ? mcpProtocolVersionsByServerId
          : undefined,
      mirrorToolParamHeaders,
      firstPageOnly,
      supportsMrtr,
      suppressListenChannel,
      dropToolListChanged,
      xaaPolicy,
    };
  }, [
    activeHost?.serverConnectionOverrides,
    activeMcpProfile,
    hostedServerIdsByName,
    projectServerConfigDto?.overrides,
    // The hosted protocol-version map now derives the OAuth-era pin from each
    // server's config/OAuth profile, so it must recompute when server state
    // changes (e.g. a modal-saved 2026 profile or a persisted config pin).
    appState.servers,
  ]);
  useApiContext({
    projectId: convexProjectId,
    serverIdsByName: hostedServerIdsByName,
    clientCapabilities: hostedClientCapabilities,
    clientInfo: hostedMcpProfilePins.clientInfo,
    supportedProtocolVersions: hostedMcpProfilePins.supportedProtocolVersions,
    mcpProtocolVersionsByServerId:
      hostedMcpProfilePins.mcpProtocolVersionsByServerId,
    mirrorToolParamHeaders: hostedMcpProfilePins.mirrorToolParamHeaders,
    firstPageOnly: hostedMcpProfilePins.firstPageOnly,
    supportsMrtr: hostedMcpProfilePins.supportsMrtr,
    xaaPolicy: hostedMcpProfilePins.xaaPolicy,
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

  const navigateToTarget = useCallback(
    (target: string, options?: { replace?: boolean }) => {
      navigateApp(navigationTargetToPath(target), options);
    },
    [],
  );
  const navigateToServers = useCallback(
    (options?: { replace?: boolean }) => {
      // Compared on the LOGICAL path: `/p/<id>/servers` is already Servers,
      // and re-navigating would push a duplicate history entry that Back has
      // to be pressed through twice.
      const logicalPathname = stripProjectFromPath(window.location.pathname);
      if (logicalPathname === routePaths.servers) {
        return;
      }
      navigateToTarget(routePaths.servers, options);
    },
    [navigateToTarget],
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
    if (!HOSTED_MODE || !isHostedTabBlocked(activeTab)) {
      return;
    }
    toast.error(`${activeTab} is not available in hosted mode.`);
    setActiveOrganizationId(undefined);
    if (window.location.pathname !== routePaths.servers) {
      navigateApp(routePaths.servers, { replace: true });
    }
  }, [activeTab, setActiveOrganizationId]);

  // Registered in BOTH local and hosted modes: these handlers serve the
  // local SSE command bus (which only subscribes in local mode) AND the
  // WebMCP UI tools, which work everywhere. Hosted-blocked navigation
  // targets are rejected per the hosted tab policy instead of silently
  // falling back.
  useLayoutEffect(() => {
    const unregisterNavigate = registerInspectorCommandHandler(
      "navigate",
      async (rawCommand) => {
        const command = rawCommand as NavigateInspectorCommand;
        const resolved = resolveUiNavigationTarget(command.payload.target);
        if (!resolved.ok) {
          throw createInspectorCommandClientError(
            "invalid_request",
            resolved.reason,
          );
        }

        navigateApp(resolved.path);
        await waitForUiCommit();

        // Resolve from where the shell ACTUALLY landed, not the requested tab:
        // a gating effect (feature flags, hosted policy) can redirect right
        // after the navigation commits. Using the committed tab means a
        // redirect away from a group surface won't make us wait 1.5s for tools
        // that will never register there.
        const committedTab = pathnameToActiveTab(window.location.pathname);

        // Same-turn advertisement for mount-scoped tool groups: a surface with
        // `agentTools.kind === "group"` registers its tools in a layout effect
        // as it mounts, and the chat pipeline drains the registry per POST —
        // waiting here lets the auto-resume POST after this tool call already
        // advertise the group, instead of burning a model turn before the
        // tools appear. The boolean is deliberately ignored: on timeout the
        // next POST simply re-snapshots whatever is registered by then (the
        // tools are additive context, not a precondition).
        const landedSurface = getAppSurfaceByNavSegment(committedTab);
        if (landedSurface?.agentTools.kind === "group") {
          await waitForUiToolNames(
            listSurfaceGroupToolNames(landedSurface.id),
            1500,
          );
        }

        // Report the tab the shell actually landed on — the caller (SSE bus /
        // WebMCP UI tools) plans its next step from this.
        return { activeTab: pathnameToActiveTab(window.location.pathname) };
      },
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
            `Unknown server "${command.payload.serverName}".`,
          );
        }

        const connectionStatus =
          serverState.runtimeServer?.connectionStatus ??
          serverState.projectServer?.connectionStatus ??
          "disconnected";
        if (connectionStatus !== "connected") {
          throw createInspectorCommandClientError(
            "disconnected_server",
            `Server "${command.payload.serverName}" is ${connectionStatus}.`,
          );
        }

        setSelectedServer(command.payload.serverName);
        await waitForUiCommit();

        return {
          selectedServer: command.payload.serverName,
          connectionStatus,
        };
      },
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
              `Unknown server "${command.payload.serverName}".`,
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
              runtimeForPersist,
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
      },
    );

    // The ONE `snapshotApp` handler. Surfaces contribute via the provider
    // registry rather than registering their own handler here: the bus
    // dispatches newest-first and returns the first success, so a second
    // handler would shadow this one whenever its surface happened to be
    // mounted — a whole-app snapshot would silently become a one-screen one.
    //
    // Always registered, so `ui_snapshot_app` works from anywhere. It stays
    // read-only: it never mounts a surface to observe it, which is what
    // makes its `readOnlyHint` (and its approval exemption) honest.
    const unregisterSnapshotApp = registerInspectorCommandHandler(
      "snapshotApp",
      async (rawCommand) => {
        const command = rawCommand as SnapshotAppInspectorCommand;
        const hasSurfaceKey =
          command.payload != null && "surface" in command.payload;
        const requested = command.payload?.surface;

        // Handlers cast rather than parse, so the type is no guarantee. An
        // absent `surface` means whole-app; a PRESENT surface that isn't a
        // real id (empty string, junk) is an error, not a silent fall-through
        // to whole-app.
        if (hasSurfaceKey && !isAppSurfaceId(requested)) {
          throw createInspectorCommandClientError(
            "invalid_request",
            `Invalid surface ${JSON.stringify(
              requested,
            )}. Omit it to snapshot the whole app, or pass a known screen id.`,
          );
        }

        if (requested) {
          const result = await readSurfaceSnapshot(requested);
          if (!result.ok) {
            // A missing provider means the screen isn't open (recoverable by
            // navigating); a provider that threw or timed out is a genuine
            // execution failure. Same error string, different code — the
            // agent reacts differently to each.
            if (result.reason === "no_provider") {
              throw createInspectorCommandClientError(
                "unsupported_in_mode",
                `${result.error} That screen is not open — navigate to it first, or omit "surface" for app-level state.`,
              );
            }
            throw createInspectorCommandClientError(
              "execution_failed",
              result.error,
            );
          }
          return { surface: requested, [requested]: result.data };
        }

        const pathname = window.location.pathname;
        // "none" is the no-selection sentinel — don't report it as a server.
        const focused =
          selectedServerRef.current && selectedServerRef.current !== "none"
            ? selectedServerRef.current
            : undefined;
        const selectedServers = appState.selectedMultipleServers?.length
          ? appState.selectedMultipleServers
          : focused
            ? [focused]
            : [];
        return {
          path: pathname,
          activeTab: pathnameToActiveTab(pathname),
          selectedServers,
          servers: Object.entries(projectServersRef.current).map(
            ([name, server]) => ({
              name,
              connectionStatus:
                (server as { connectionStatus?: string })?.connectionStatus ??
                "unknown",
            }),
          ),
          surfaces: await readAllSurfaceSnapshots(),
        };
      },
    );

    // --- Connect-screen commands -------------------------------------
    // These delegate to the SAME action layer the Connect screen's own
    // buttons use (`use-app-state`), so an agent-added server is
    // byte-identical to a hand-added one. No DOM events, no component
    // internals — the difference between driving the app and puppeting it.

    const requireKnownServer = (serverName: string) => {
      const state = getInspectorServerState(serverName);
      if (!state) {
        throw createInspectorCommandClientError(
          "unknown_server",
          `Unknown server "${serverName}".`,
        );
      }
      return state;
    };

    const readConnectionStatus = (serverName: string) => {
      const state = getInspectorServerState(serverName);
      return (
        state?.runtimeServer?.connectionStatus ??
        state?.projectServer?.connectionStatus ??
        "disconnected"
      );
    };

    // `addServer` lives in ServersTab, NOT here: creating a server has to
    // honor `BILLING_GATES.serverCreation`, and that gate is a hook that only
    // exists on the Connect screen. Registering it here would have bypassed
    // the same limit the Add button enforces. connect/disconnect/remove don't
    // create servers, so they stay App-level.

    const unregisterConnectServer = registerInspectorCommandHandler(
      "connectServer",
      async (rawCommand) => {
        const command = rawCommand as ConnectServerInspectorCommand;
        const serverName = command.payload.serverName;
        requireKnownServer(serverName);

        const result = await connectServerWithResultRef.current(serverName);
        await waitForUiCommit();

        // Report what happened, including the outcomes that are neither
        // success nor failure. `reauth` is the important one: the server
        // needs the USER to authorize it, and saying "failed" would send
        // the agent off retrying something only a human can finish.
        if (result.status === "reauth") {
          return {
            serverName,
            status: "authorization_required",
            connectionStatus: readConnectionStatus(serverName),
            message: `"${serverName}" needs authorization. The user must click Authorize on the Connect screen; it opens their identity provider.`,
          };
        }
        if (result.status === "superseded") {
          return {
            serverName,
            status: "superseded",
            message: `Another connection attempt for "${serverName}" is already in flight; leaving it alone.`,
          };
        }
        if (result.status !== "connected") {
          throw createInspectorCommandClientError(
            "execution_failed",
            result.error ?? `Could not connect "${serverName}".`,
          );
        }

        return {
          serverName,
          status: "connected",
          connectionStatus: readConnectionStatus(serverName),
        };
      },
    );

    const unregisterDisconnectServer = registerInspectorCommandHandler(
      "disconnectServer",
      async (rawCommand) => {
        const command = rawCommand as DisconnectServerInspectorCommand;
        const serverName = command.payload.serverName;
        requireKnownServer(serverName);

        await handleDisconnectRef.current(serverName);
        await waitForUiCommit();
        return {
          serverName,
          connectionStatus: readConnectionStatus(serverName),
        };
      },
    );

    const unregisterRemoveServer = registerInspectorCommandHandler(
      "removeServer",
      async (rawCommand) => {
        const command = rawCommand as RemoveServerInspectorCommand;
        const serverName = command.payload.serverName;
        requireKnownServer(serverName);

        await handleRemoveServerRef.current(serverName);
        await waitForUiCommit();

        // Verify rather than assume: `handleRemoveServer` resolves void and
        // the tool result is the only thing the user will read.
        if (getInspectorServerState(serverName)) {
          throw createInspectorCommandClientError(
            "execution_failed",
            `"${serverName}" is still present after the remove.`,
          );
        }
        return { serverName, removed: true };
      },
    );

    return () => {
      unregisterNavigate();
      unregisterSelectServer();
      unregisterOpenPlayground();
      unregisterSnapshotApp();
      unregisterConnectServer();
      unregisterDisconnectServer();
      unregisterRemoveServer();
    };
  }, [
    appState.selectedMultipleServers,
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

  // The snap-to-Servers effect that used to live here is gone with the URL
  // migration. It existed because a project switch changed hidden state and
  // left the URL naming a resource in the project being left; now the URL is
  // the switch, so there is nothing to repair afterwards — and an effect that
  // navigates on every observed project change would race the coordinator
  // that just performed one.

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
      selectableOrganizations,
      activeOrganizationId,
      projectOrgId,
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
    selectableOrganizations,
    workOsUser?.id,
  ]);

  useEffect(() => {
    if (
      activeTabBillingLocked &&
      activeTabBillingFeature &&
      activeTab !== "scenarios"
    ) {
      toast.error(
        `${formatBillingFeatureName(
          activeTabBillingFeature,
        )} is not included in the ${formatPlanName(
          shellBillingStatus?.plan,
        )} plan. Upgrade the organization to continue.`,
      );
      navigateToTarget(defaultHubRoute, { replace: true });
    } else if (activeTab === "clients" && !isAuthenticated && !isAuthLoading) {
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
    xaaEnabled,
    isAuthenticated,
    isAuthLoading,
    activeTab,
    navigateToTarget,
  ]);

  const handleNavigate = (section: string) => {
    navigateToTarget(section);
  };

  const handleSidebarSwitchOrganization = useCallback(
    (
      organizationId: string,
      section: OrganizationRouteSection = "overview",
    ) => {
      setActiveOrganizationId(organizationId);
      navigateApp(buildOrganizationPath(organizationId, section));
    },
    [setActiveOrganizationId],
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
    [activeOrganizationId, setActiveOrganizationId, navigateToServers],
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
    [setSelectedMCPConfigs],
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
          : [...currentIds, deletedOrganizationId],
      );

      const remainingOrganizations = selectableOrganizations.filter(
        (organization) => organization._id !== deletedOrganizationId,
      );
      const fallbackOrganizationId = resolveDeletedOrganizationFallbackId(
        remainingOrganizations,
      );
      const isDeletedCurrentOrganization =
        activeOrganizationId === deletedOrganizationId ||
        routeOrganizationId === deletedOrganizationId ||
        activeProject?.organizationId === deletedOrganizationId;

      clearLocalFallbackProjectSelection(
        deletedOrganizationId,
        fallbackOrganizationId,
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
      selectableOrganizations,
      navigateToServers,
      routeOrganizationId,
      setActiveOrganizationId,
    ],
  );

  // The URL owns which project this tab is on. This reconciles the two
  // continuously — on cold open, on Back/Forward, and on every in-app
  // navigation — switching organization first when the link crosses one.
  const { allProjects: allMembershipProjects } = useProjectQueries({
    isAuthenticated,
  });
  // Silent: the URL already told the user which project they are in, so a
  // toast on every cold open of a shared link would be narrating the address
  // bar back at them.
  const switchProjectForRoute = useCallback(
    (projectId: string) => handleSwitchProject(projectId, { silent: true }),
    [handleSwitchProject],
  );
  const projectRouteState = useProjectRouteCoordinator({
    isAuthenticated,
    isAuthLoading,
    isLoadingRemoteProjects,
    projects,
    allProjects: allMembershipProjects,
    activeProjectId,
    activeOrganizationId,
    setActiveOrganizationId,
    switchProject: switchProjectForRoute,
  });

  /**
   * Picking another project in the switcher NAVIGATES. It does not switch
   * state and then repair the URL: that ordering is what let a stale effect
   * bounce the user off the page they had just opened, and it left the
   * address bar naming project A while the app rendered project B.
   */
  const handleSidebarSwitchProject = useCallback(
    (projectId: string) => {
      navigateToTarget(buildProjectSwitchTarget(projectId));
    },
    [navigateToTarget],
  );

  /** The switcher's per-row gear — one gesture, one URL, no pre-switch. */
  const handleSidebarOpenProjectSettings = useCallback(
    (projectId: string) => {
      navigateToTarget(buildProjectSettingsTarget(projectId));
    },
    [navigateToTarget],
  );

  /**
   * Deleting the project you are looking at has to move the URL, because the
   * URL is what names it. Left alone, the address bar would keep pointing at
   * a project that no longer exists and the route boundary would render the
   * inaccessible state on a deletion the user performed deliberately.
   *
   * The fallback is VALIDATED — a project still visible in this organization,
   * preferring the default one — and when there is none the viewer goes to
   * the unscoped root, which is the onboarding/no-project surface. A guessed
   * or stale id here would put someone in a project they did not choose.
   */
  const handleDeleteProjectAndLeave = useCallback(
    async (projectId: string) => {
      const remainingIds = Object.keys(projects).filter(
        (id) => id !== projectId,
      );
      const fallbackProjectId =
        remainingIds.find((id) => (projects[id] as any)?.isDefault) ??
        remainingIds[0] ??
        null;

      const deleted = await handleDeleteProject(projectId);
      if (!deleted) return deleted;
      // Only the tab whose URL named the deleted project moves. A deletion
      // performed from Project settings while parked on a global route (say
      // Organizations) should not yank the user off it.
      if (readProjectPathSegment(window.location.pathname) !== projectId) {
        return deleted;
      }
      if (fallbackProjectId && isProjectIdShape(fallbackProjectId)) {
        navigateApp(buildProjectPath(fallbackProjectId, routePaths.servers), {
          replace: true,
        });
      } else {
        // `unscoped`: the current URL still names the project that was just
        // deleted, and the ordinary scope inheritance would carry that id
        // straight back into the root target.
        navigateApp(routePaths.root, { replace: true, unscoped: true });
      }
      return deleted;
    },
    [handleDeleteProject, projects],
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
    PlaygroundServerSelectorProps | undefined => {
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

  // MCP OAuth completion/reconnect is handled by useServerState above. Keep
  // the app shell hidden until that effect restores the exact saved route so
  // the Servers tab never flashes between the authorization server and chat.
  if (isMcpOAuthCallback && !isProjectMcpOAuthCallback) {
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
    activeTab === "chat";

  const oauthDebuggerHasHeaderServers = hasDebuggerHeaderServers({
    serverConfigs: projectServers,
    hiddenServers: hiddenHeaderServers,
  });
  const xaaDebuggerHasHeaderServers = hasDebuggerHeaderServers({
    serverConfigs: projectServers,
    hiddenServers: hiddenHeaderServers,
    includeXaaServers: true,
  });

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
          // Only the OAuth / XAA debugger headers get the "hide from this tab"
          // x button; other surfaces omit onHideServer so no x renders.
          hiddenServers: hiddenHeaderServers,
          onHideServer: headerHiddenSurface ? hideHeaderServer : undefined,
          // Debugger tabs: if the header has an eligible target and NOTHING
          // is selected yet, select it instead of leaving the canvas in a
          // prompt-less empty state — but never replace an existing
          // selection, since the debuggers fire live auth requests at their
          // target and it must not change without an explicit click. Other
          // tabs keep full auto-select (stale selections get replaced).
          autoSelectFilteredServer:
            activeTab === "oauth-flow" ||
            (activeTab === "xaa-flow" && xaaEnabled === true)
              ? "when-empty"
              : true,
          showOnlyServersWithViews: false,
          hasMessages: false,
        }
      : undefined;

  const isEvalsTab = activeTab === "evals" || activeTab === "evaluate";
  const globalHostBarProps =
    isAuthenticated &&
    convexProjectId &&
    !isEvalsTab &&
    // The playground has its own client chip in the chat-input toolbar
    // (switch / compare / add host), so the global host bar is redundant
    // there. User Testing and Swarms are project-scoped lists, not per-host
    // screens, so a global host selector would be selecting nothing.
    activeTab !== "playground" &&
    activeTab !== "scenarios" &&
    activeTab !== "swarms" &&
    // The OAuth / XAA debuggers target a specific server via their own server
    // picker; the global host/client bar is irrelevant there.
    activeTab !== "oauth-flow" &&
    activeTab !== "xaa-flow"
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
    selectableOrganizations.some((org) => org._id === rawHomeOrganizationId)
      ? rawHomeOrganizationId
      : null;

  const routeContext: AppRouteContext = {
    // What the URL's project segment resolved to. `ProjectRouteBoundary`
    // renders on it, and the legacy normalizer reads the rest of this bag to
    // decide which project an old link should adopt.
    projectRouteState,
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
    handleCheckoutIntentNavigationStarted,
    handleConnect,
    handleConnectWithTokensFromOAuthFlow,
    handleContinueEvalInChat,
    handleDeleteProject: handleDeleteProjectAndLeave,
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
    isClientConfigSyncPending,
    isGuestProjectActor,
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
    oauthDebuggerHasHeaderServers,
    xaaDebuggerHasHeaderServers,
    xaaServerModalNonce,
    oauthServerModalNonce,
  };

  // Shared by the top bar and the middle panel: the panel's 16px top radius +
  // shadow are only correct when the bar is above them.
  const appChromeHeaderHidden =
    playgroundOnboarding || (activeTab === "home" && !!workOsUser);

  const appContent = (
    <SidebarProvider defaultOpen={true}>
      <AppChromeSidebar
        hidden={playgroundOnboarding}
        onNavigate={handleNavigate}
        activeTab={activeTab}
        projects={projects}
        activeProjectId={activeProjectId}
        onSwitchProject={handleSidebarSwitchProject}
        onOpenProjectSettings={handleSidebarOpenProjectSettings}
        onCreateProject={handleCreateProject}
        onDeleteProject={handleDeleteProjectAndLeave}
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
      {/* The inset is the linen shell: the sidebar and top bar read as one
          continuous outer chrome and the off-white panel below is the working
          surface. `bg-sidebar` overrides the primitive's `bg-background`. */}
      <SidebarInset className="bg-sidebar flex flex-col min-h-0">
        <AppChromeHeader
          // "make nux clean" (#2868) hid this on Home for everyone, but that
          // also hid guests' only Sign in / Create account affordance there
          // (PUR-35). Keep Home clean for signed-in users; show the header
          // for guests so they still get sign-in/sign-up.
          hidden={appChromeHeaderHidden}
          activeServerSelectorProps={activeServerSelectorProps}
          globalHostBarProps={globalHostBarProps}
        />
        <AppChromePanel headerHidden={appChromeHeaderHidden}>
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
        </AppChromePanel>
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
                    `organizations/${billingOrganizationId}/billing`,
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

  // Vanity-domain caniuse.dev pages: render the matched route full-bleed
  // without the sidebar/header chrome.
  // Still nested inside every provider in the return below, so auth, project,
  // and the guest session resolve exactly as on the normal route.
  const bareCompareContent = (
    <div className="flex h-[100dvh] min-w-0 max-w-full flex-col overflow-hidden bg-background">
      <div className="min-h-0 min-w-0 flex-1 overflow-hidden">
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
            ensureHostedServerIdsForNames,
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
            <PlanLimitDialog />
            <SessionRefreshBanner />
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
              >
                {isScenarioChatRoute ? (
                  <ScenarioChatPage
                    pathToken={scenarioPathToken}
                    onExitScenarioChat={() => setExitedScenarioChat(true)}
                  />
                ) : isBareCaniuseRoute ? (
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
